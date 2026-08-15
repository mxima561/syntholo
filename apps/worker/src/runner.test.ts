import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseWorkerConfig } from "./config.js";
import {
  createDomainEventJobHandler,
  establishWorkerReadiness,
  handlersForOutboxEvent,
  runOutboxPump,
  runCertificatePromoter,
  runCertificateRecovery,
  runWorker,
  createWorkerId,
  startWorker,
  superviseWorkerPumps,
  type WorkerDependencies,
  type WorkerJob,
} from "./runner.js";
import { FatalWorkerConsistencyError, HandlerFailure } from "./handlers/index.js";
import { createCertificateGenerationHandler } from "./handlers/certificates/generate.js";
import { CertificateBlobError } from "@syntholo/integrations";
import type { ClaimedJob, HandlerReceiptClaim } from "@syntholo/database";
import { CertificateGenerationConsistencyError } from "@syntholo/database";

const execFileAsync = promisify(execFile);
const now = new Date("2026-08-13T12:00:00.000Z");
const releaseSha = "0123456789abcdef0123456789abcdef01234567";

function jobRepository(claim = vi.fn(async () => [] as readonly WorkerJob[])) {
  const complete: WorkerDependencies<WorkerJob>["jobs"]["complete"] =
    async () => ({ kind: "completed" });
  const fail: WorkerDependencies<WorkerJob>["jobs"]["fail"] = async () =>
    ({ kind: "retry_scheduled", runAt: now });
  const extendLease: WorkerDependencies<WorkerJob>["jobs"]["extendLease"] =
    async () => ({ kind: "extended", leaseExpiresAt: now });
  return {
    claim,
    complete: vi.fn(complete),
    extendLease: vi.fn(extendLease),
    fail: vi.fn(fail),
    heartbeatIntervalMs: 20_000,
  } satisfies WorkerDependencies<WorkerJob>["jobs"];
}

function dependencies(
  patch: Partial<WorkerDependencies<WorkerJob>> = {},
): WorkerDependencies<WorkerJob> {
  return {
    config: {
      databaseUrl: "postgres://worker:password@example.test/db",
      releaseSha,
      concurrency: 2,
      idleDelayMs: 1_000,
    },
    workerId: "worker-test",
    clock: { now: () => now },
    jobs: jobRepository(),
    handlers: {
      handle: vi.fn(async (job: WorkerJob) => {
        void job;
      }),
    },
    random: () => 0,
    ...patch,
  };
}

describe("worker configuration and startup", () => {
  it("builds a deterministic bounded worker ID from unusual or long hostnames", () => {
    const id = createWorkerId(` host name / ${"x".repeat(300)}`, 123);
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(createWorkerId("host", 123)).toBe(createWorkerId("host", 123));
    expect(createWorkerId("host", 123, true)).toMatch(/-certificate-v1$/u);
    expect(createWorkerId("host", 123, true).length).toBeLessThanOrEqual(128);
  });
  it("parses and preserves validated worker startup values", () => {
    expect(
      parseWorkerConfig({
        DATABASE_URL: "  postgres://worker:password@example.test/db  ",
        RELEASE_SHA: `  ${releaseSha}  `,
        WORKER_CONCURRENCY: "4",
        WORKER_IDLE_DELAY_MS: "750",
      }),
    ).toEqual({
      databaseUrl: "postgres://worker:password@example.test/db",
      releaseSha,
      concurrency: 4,
      idleDelayMs: 750,
      mux: { enabled: false },
    });
  });

  it("requires one complete Mux reconciliation credential pair when enabled", () => {
    const base = {
      DATABASE_URL: "postgres://worker:password@example.test/db",
      RELEASE_SHA: releaseSha,
      WORKER_CONCURRENCY: "2",
    };
    expect(parseWorkerConfig({
      ...base,
      MUX_CONTENT_ENABLED: "true",
      MUX_ENVIRONMENT_ID: "env_staging",
      MUX_RECONCILE_TOKEN_ID: "mux-id",
      MUX_RECONCILE_TOKEN_SECRET: "mux-secret-value",
    })).toMatchObject({ mux: {
      enabled: true,
      environmentId: "env_staging",
      tokenId: "mux-id",
      tokenSecret: "mux-secret-value",
    } });
    for (const environment of [
      { ...base, MUX_CONTENT_ENABLED: "true" },
      { ...base, MUX_CONTENT_ENABLED: "true", MUX_RECONCILE_TOKEN_ID: "mux-id", MUX_RECONCILE_TOKEN_SECRET: "mux-secret-value" },
      { ...base, MUX_RECONCILE_TOKEN_ID: "mux-id" },
      { ...base, MUX_RECONCILE_TOKEN_SECRET: "mux-secret-value" },
      { ...base, MUX_ENVIRONMENT_ID: "env_staging" },
      { ...base, MUX_CONTENT_ENABLED: "true", MUX_RECONCILE_TOKEN_ID: "mux-id" },
    ]) expect(() => parseWorkerConfig(environment)).toThrow("WORKER_CONFIG_INVALID");
  });

  it("requires one exact environment-bound private certificate Blob configuration", () => {
    const base = {
      DATABASE_URL: "postgres://worker:password@example.test/db",
      RELEASE_SHA: releaseSha,
      WORKER_CONCURRENCY: "2",
    };
    expect(parseWorkerConfig({
      ...base,
      CERTIFICATE_BLOB_ENABLED: "true",
      DEPLOYMENT_ENVIRONMENT: "staging",
      CERTIFICATE_BLOB_ENVIRONMENT: "staging",
      CERTIFICATE_BLOB_TOKEN: "vercel_blob_rw_stagingcertificates_abcdefghijklmnopqrstuvwxyz012345",
      CERTIFICATE_BLOB_STAGING_STORE_ID: "stagingcertificates",
      CERTIFICATE_BLOB_PRODUCTION_STORE_ID: "productioncertificates",
      CERTIFICATE_BLOB_OPERATION_TIMEOUT_MS: "12000",
    })).toMatchObject({ certificateBlob: {
      enabled: true,
      environment: "staging",
      operationTimeoutMs: 12_000,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
    } });
    for (const environment of [
      { ...base, CERTIFICATE_BLOB_ENABLED: "true" },
      { ...base, CERTIFICATE_BLOB_ENABLED: "true", CERTIFICATE_BLOB_ENVIRONMENT: "staging" },
      { ...base, CERTIFICATE_BLOB_TOKEN: "secret-without-store-authority" },
      {
        ...base,
        CERTIFICATE_BLOB_ENABLED: "true",
        DEPLOYMENT_ENVIRONMENT: "production",
        CERTIFICATE_BLOB_ENVIRONMENT: "production",
        CERTIFICATE_BLOB_TOKEN: "vercel_blob_rw_same_abcdefghijklmnopqrstuvwxyz012345",
        CERTIFICATE_BLOB_STAGING_STORE_ID: "same",
        CERTIFICATE_BLOB_PRODUCTION_STORE_ID: "same",
      },
      {
        ...base,
        CERTIFICATE_BLOB_ENABLED: "true",
        DEPLOYMENT_ENVIRONMENT: "production",
        CERTIFICATE_BLOB_ENVIRONMENT: "staging",
        CERTIFICATE_BLOB_TOKEN: "vercel_blob_rw_stagingcertificates_abcdefghijklmnopqrstuvwxyz012345",
        CERTIFICATE_BLOB_STAGING_STORE_ID: "stagingcertificates",
        CERTIFICATE_BLOB_PRODUCTION_STORE_ID: "productioncertificates",
      },
    ]) expect(() => parseWorkerConfig(environment)).toThrow("WORKER_CONFIG_INVALID");
  });

  it("rejects malformed and artifact-mismatched release identity", () => {
    const environment = {
      DATABASE_URL: "postgres://worker:password@example.test/db",
      WORKER_CONCURRENCY: "2",
    };
    expect(() => parseWorkerConfig({ ...environment, RELEASE_SHA: "ABC" }, releaseSha))
      .toThrow("WORKER_CONFIG_INVALID");
    expect(() => parseWorkerConfig({
      ...environment,
      RELEASE_SHA: "1123456789abcdef0123456789abcdef01234567",
    }, releaseSha)).toThrow("WORKER_CONFIG_INVALID");
  });

  it.each([
    [{ RELEASE_SHA: "release", WORKER_CONCURRENCY: "2" }],
    [{ DATABASE_URL: "postgres://user:secret@example.test/db", WORKER_CONCURRENCY: "2" }],
    [{ DATABASE_URL: "postgres://user:secret@example.test/db", RELEASE_SHA: "release" }],
    [{ DATABASE_URL: "postgres://user:secret@example.test/db", RELEASE_SHA: "release", WORKER_CONCURRENCY: "0" }],
    [{ DATABASE_URL: "postgres://user:secret@example.test/db", RELEASE_SHA: "release", WORKER_CONCURRENCY: "1.5" }],
    [{ DATABASE_URL: "postgres://user:secret@example.test/db", RELEASE_SHA: "release", WORKER_CONCURRENCY: "101" }],
  ])("fails closed for invalid worker configuration", (environment) => {
    expect(() => parseWorkerConfig(environment)).toThrow(
      "WORKER_CONFIG_INVALID",
    );
    try {
      parseWorkerConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("postgres://");
    }
  });

  it("validates configuration before creating dependencies or claiming", async () => {
    const createDependencies = vi.fn();
    const controller = new AbortController();

    await expect(
      startWorker({
        env: { RELEASE_SHA: "release", WORKER_CONCURRENCY: "2" },
        signal: controller.signal,
        createDependencies,
      }),
    ).rejects.toThrow("WORKER_CONFIG_INVALID");
    expect(createDependencies).not.toHaveBeenCalled();
  });

  it("does not transition from draining back to ready when shutdown arrives during readiness", async () => {
    const controller = new AbortController();
    let finishReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => {
      finishReadiness = resolve;
    });
    const markReady = vi.fn();
    const running = establishWorkerReadiness(
      async () => readiness,
      controller.signal,
      markReady,
    );

    controller.abort();
    finishReadiness();

    await expect(running).resolves.toBe(false);
    expect(markReady).not.toHaveBeenCalled();
  });
});

describe("runWorker", () => {
  it("rejects an incomplete direct runtime configuration before claiming", async () => {
    const controller = new AbortController();
    const claim = vi.fn(async () => {
      controller.abort();
      return [];
    });

    await expect(
      runWorker(
        dependencies({
          config: {
            databaseUrl: "postgres://worker:password@example.test/db",
            releaseSha: "",
            concurrency: 2,
            idleDelayMs: 1_000,
          },
          jobs: jobRepository(claim),
        }),
        controller.signal,
      ),
    ).rejects.toThrow("WORKER_CONFIG_INVALID");
    expect(claim).not.toHaveBeenCalled();
  });

  it("honors a signal that is already aborted without claiming or waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    const claim = vi.fn(async () => []);
    const wait = vi.fn(async () => undefined);

    await runWorker(dependencies({ jobs: jobRepository(claim), wait }), controller.signal);

    expect(claim).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("passes concurrency, worker id, and the exact clock value then handles every claimed job", async () => {
    const controller = new AbortController();
    const jobs = [
      { id: "job-1", type: "test.one" },
      { id: "job-2", type: "test.two" },
    ] as const;
    const claim = vi.fn(async () => {
      controller.abort();
      return jobs;
    });
    const handle = vi.fn(async (job: WorkerJob) => {
      void job;
    });
    const deps = dependencies({
      config: {
        databaseUrl: "postgres://worker:password@example.test/db",
        releaseSha,
        concurrency: 7,
        idleDelayMs: 1_000,
      },
      workerId: "worker-exact",
      clock: { now: () => now },
      jobs: jobRepository(claim),
      handlers: { handle },
    });

    await runWorker(deps, controller.signal);

    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(7, "worker-exact", now);
    expect(handle.mock.calls.map(([job]) => job)).toEqual(jobs);
  });

  it("uses the injected idle wait once for an empty poll and passes the signal", async () => {
    const controller = new AbortController();
    const claim = vi.fn(async () => []);
    const wait = vi.fn(async (delayMs: number, signal: AbortSignal) => {
      expect(delayMs).toBe(2_500);
      expect(signal).toBe(controller.signal);
      controller.abort();
    });

    await runWorker(
      dependencies({
        config: {
          databaseUrl: "postgres://worker:password@example.test/db",
          releaseSha,
          concurrency: 2,
          idleDelayMs: 2_500,
        },
        jobs: jobRepository(claim),
        wait,
      }),
      controller.signal,
    );

    expect(claim).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("interrupts the default idle delay on abort instead of spinning or hanging", async () => {
    const controller = new AbortController();
    const claim = vi.fn(async () => []);
    const started = Date.now();
    const running = runWorker(
      dependencies({
        config: {
          databaseUrl: "postgres://worker:password@example.test/db",
          releaseSha,
          concurrency: 2,
          idleDelayMs: 60_000,
        },
        jobs: jobRepository(claim),
      }),
      controller.signal,
    );

    while (claim.mock.calls.length === 0) await Promise.resolve();
    controller.abort();
    await running;

    expect(claim).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("records one handler failure without abandoning successful siblings", async () => {
    const controller = new AbortController();
    const claimed = [
      { id: "job-fails", type: "test.one" },
      { id: "job-succeeds", type: "test.two" },
    ];
    const claim = vi.fn(async () => {
      controller.abort();
      return claimed;
    });
    const repository = jobRepository(claim);
    const handle = vi.fn(async (job: WorkerJob) => {
      if (job.id === "job-fails") throw new Error("unpersisted detail");
    });

    await runWorker(dependencies({
      handlers: { handle },
      jobs: repository,
    }), controller.signal);

    expect(repository.fail).toHaveBeenCalledWith(
      claimed[0],
      { code: "JOB_HANDLER_FAILED", permanent: false },
      now,
      0,
    );
    expect(repository.complete).toHaveBeenCalledWith(claimed[1], now);
  });

  it("composes certificate storage failure through the runner and authorizes recovery of the same dead-letter job", async () => {
    const controller = new AbortController();
    const claimedJob = Object.freeze({
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
    let polls = 0;
    const claim = vi.fn(async () => {
      polls += 1;
      if (polls === 1) return [claimedJob];
      controller.abort();
      return [];
    });
    const repository = jobRepository(claim);
    repository.fail.mockResolvedValueOnce({ kind: "dead_lettered" } as never);
    const generation = Object.freeze({
      kind: "pending" as const,
      certificateId: claimedJob.payload.certificateId,
      courseCompletionId: claimedJob.payload.courseCompletionId,
      accountId: claimedJob.accountId,
      recipientName: "Ada Lovelace",
      businessName: "Syntholo Test Account",
      courseTitle: "Syntholo Academy",
      courseVersion: 1,
      completedAt: "2026-08-15T12:00:00.000Z",
    });
    const certificateRepository = {
      loadGenerationFence: vi.fn(async () => generation),
      loadIssuedFile: vi.fn(),
      finalize: vi.fn(),
      markFailed: vi.fn(async () => ({ kind: "failed" as const })),
    };
    const pdf = new TextEncoder().encode("%PDF-1.7\ncertificate");
    const generationHandler = createCertificateGenerationHandler({
      repository: certificateRepository,
      blob: {
        upload: vi.fn(async () => {
          throw new CertificateBlobError("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false);
        }),
        reconcileUpload: vi.fn(),
      },
      render: vi.fn(async () => pdf),
    });
    await runWorker(dependencies({
      handlers: {
        handle: vi.fn(async (job, signal) => generationHandler(job as ClaimedJob, signal)),
      },
      jobs: repository,
    }), controller.signal);
    expect(repository.fail).toHaveBeenCalledWith(
      claimedJob,
      { code: "JOB_HANDLER_FAILED", permanent: true },
      now,
      0,
    );
    expect(repository.complete).not.toHaveBeenCalled();
    expect(certificateRepository.markFailed).toHaveBeenCalledWith({
      jobId: claimedJob.id,
      workerId: claimedJob.workerId,
      attempt: claimedJob.attempt,
      generation: claimedJob.claimGeneration,
      claimToken: claimedJob.claimToken,
      failureCode: "storage_failed",
    }, expect.any(AbortSignal));

    const recoveryController = new AbortController();
    const recovery = {
      listStorageRetryCandidates: vi.fn(async () => [{
        certificateId: claimedJob.payload.certificateId,
        courseCompletionId: claimedJob.payload.courseCompletionId,
        accountId: claimedJob.accountId,
        recoveryJobId: claimedJob.id,
        failedAttempt: claimedJob.attempt,
        failedGeneration: claimedJob.claimGeneration,
        recipientName: generation.recipientName,
        businessName: generation.businessName,
        courseTitle: generation.courseTitle,
        courseVersion: generation.courseVersion,
        completedAt: generation.completedAt,
      }]),
      retry: vi.fn(async () => ({ kind: "pending" as const })),
      rejectStorageRecovery: vi.fn(),
    };
    await runCertificateRecovery(
      recovery,
      { reconcileUpload: vi.fn(async () => { throw new CertificateBlobError("CERTIFICATE_BLOB_NOT_FOUND", false); }) },
      vi.fn(async () => pdf),
      recoveryController.signal,
      vi.fn(async () => { recoveryController.abort(); }),
    );
    expect(recovery.retry).toHaveBeenCalledWith({
      certificateId: claimedJob.payload.certificateId,
      recoveryJobId: claimedJob.id,
      failedAttempt: claimedJob.attempt,
      failedGeneration: claimedJob.claimGeneration,
      objectState: "absent",
      byteLength: pdf.byteLength,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      etag: null,
    }, recoveryController.signal);
    expect(recovery.rejectStorageRecovery).not.toHaveBeenCalled();
  });

  it("records an undefined handler rejection instead of completing the job", async () => {
    const controller = new AbortController();
    const claimed = [{ id: "job-undefined", type: "test.one" }];
    const claim = vi.fn(async () => {
      controller.abort();
      return claimed;
    });
    const repository = jobRepository(claim);
    await runWorker(dependencies({
      handlers: { handle: vi.fn(() => Promise.reject(undefined)) },
      jobs: repository,
    }), controller.signal);
    expect(repository.fail).toHaveBeenCalledWith(
      claimed[0],
      { code: "JOB_HANDLER_FAILED", permanent: false },
      now,
      0,
    );
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("treats a stale repository transition as fatal after siblings drain", async () => {
    const controller = new AbortController();
    const claimed = [
      { id: "job-stale", type: "test.one" },
      { id: "job-drains", type: "test.two" },
    ];
    const claim = vi.fn(async () => {
      controller.abort();
      return claimed;
    });
    const repository = jobRepository(claim);
    const completed: string[] = [];
    repository.complete.mockImplementation(async (job) => {
      completed.push(job.id);
      return job.id === "job-stale"
        ? { kind: "stale_claim" as const }
        : { kind: "completed" as const };
    });

    await expect(runWorker(dependencies({ jobs: repository }), controller.signal))
      .rejects.toThrow("WORKER_TRANSITION_FAILED");
    expect(completed.sort()).toEqual(["job-drains", "job-stale"]);
  });

  it("stops claiming on shutdown but drains the active batch", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const claim = vi.fn(async () => [
      { id: "job-drain-1", type: "test.one" },
      { id: "job-drain-2", type: "test.two" },
    ]);
    const repository = jobRepository(claim);
    const running = runWorker(dependencies({
      handlers: { handle: vi.fn(async () => blocked) },
      jobs: repository,
    }), controller.signal);

    while (claim.mock.calls.length === 0) await Promise.resolve();
    controller.abort();
    release();
    await running;

    expect(claim).toHaveBeenCalledTimes(1);
    expect(repository.complete).toHaveBeenCalledTimes(2);
  });

  it("renews a blocked handler lease and treats a lost heartbeat as fatal", async () => {
    const controller = new AbortController();
    const claimed = [{ id: "job-heartbeat", type: "test.one" }];
    const claim = vi.fn(async () => {
      controller.abort();
      return claimed;
    });
    const repository = jobRepository(claim);
    repository.extendLease.mockResolvedValue({ kind: "stale_claim" });
    let handlerAborted = false;
    const heartbeatWait = vi.fn(async (_delay: number, signal: AbortSignal) => {
      if (!signal.aborted) return;
    });
    const running = runWorker(dependencies({
      heartbeatWait,
      handlers: { handle: vi.fn(async (_job, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          handlerAborted = true;
          resolve();
        }, { once: true }));
      }) },
      jobs: repository,
    }), controller.signal);
    await expect(running).rejects.toThrow("WORKER_TRANSITION_FAILED");
    expect(handlerAborted).toBe(true);
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it.each(["rejected", "stale"] as const)(
    "does not transition after the handler finishes while a lease extension is %s",
    async (outcome) => {
      const controller = new AbortController();
      const claimed = [{ id: `job-late-${outcome}`, type: "test.one" }];
      const claim = vi.fn(async () => {
        controller.abort();
        return claimed;
      });
      const repository = jobRepository(claim);
      let settleExtension!: () => void;
      repository.extendLease.mockImplementation(() => new Promise((resolve, reject) => {
        settleExtension = () => outcome === "rejected"
          ? reject(new Error("unpersisted lease detail"))
          : resolve({ kind: "stale_claim" });
      }));
      let finishHandler!: () => void;
      const handler = new Promise<void>((resolve) => { finishHandler = resolve; });
      const running = runWorker(dependencies({
        heartbeatWait: async () => undefined,
        handlers: { handle: vi.fn(async () => handler) },
        jobs: repository,
      }), controller.signal);

      while (repository.extendLease.mock.calls.length === 0) await Promise.resolve();
      finishHandler();
      await Promise.resolve();
      settleExtension();

      await expect(running).rejects.toThrow("WORKER_TRANSITION_FAILED");
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.fail).not.toHaveBeenCalled();
    },
  );

  it("bounds a fatal batch drain when a sibling ignores its AbortSignal", async () => {
    const controller = new AbortController();
    const claim = vi.fn(async () => {
      controller.abort();
      return [
        { id: "job-fatal", type: "test.one" },
        { id: "job-ignores-abort", type: "test.two" },
      ];
    });
    const repository = jobRepository(claim);
    const never = new Promise<void>(() => undefined);
    const fatalDrainWait = vi.fn(async () => undefined);

    await expect(runWorker(dependencies({
      fatalDrainTimeoutMs: 25,
      fatalDrainWait,
      handlers: { handle: vi.fn(async (job) => {
        if (job.id === "job-fatal") throw new FatalWorkerConsistencyError();
        await never;
      }) },
      jobs: repository,
    }), controller.signal)).rejects.toThrow("WORKER_TRANSITION_FAILED");

    expect(fatalDrainWait).toHaveBeenCalledWith(25, expect.any(AbortSignal));
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("propagates the production fatal signal to every active handler", async () => {
    const controller = new AbortController();
    const fatalController = new AbortController();
    const claim = vi.fn(async () => [{ id: "job-active", type: "test.one" }]);
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    let handlerAborted = false;
    const running = runWorker(dependencies({
      fatalSignal: fatalController.signal,
      handlers: { handle: vi.fn(async (_job, signal) => {
        handlerStarted();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          handlerAborted = true;
          resolve();
        }, { once: true }));
      }) },
      jobs: jobRepository(claim),
    }), controller.signal);

    await started;
    fatalController.abort();
    await expect(running).rejects.toThrow("WORKER_TRANSITION_FAILED");
    expect(handlerAborted).toBe(true);
  });
});

describe("outbox and production lifecycle", () => {
  it("wires the direct certificate job to its private Blob, renderer, repository, and bounded promoter", async () => {
    const source = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
    expect(source).toContain('"learning.course_completed.certificate.v1": createCertificateGenerationHandler({');
    expect(source).toContain("config.certificateBlob === undefined ? {} : {");
    expect(source).toContain("createPrivateCertificateBlobStore(config.certificateBlob)");
    expect(source).toContain("render: renderCertificatePdf");
    expect(source).toContain("repository: certificates");
    expect(source).toContain("runCertificatePromoter(certificates, controller.signal)");
    expect(source).toContain("runCertificateRecovery(certificates, certificateBlob, renderCertificatePdf, controller.signal)");
    expect(source.indexOf("createPrivateCertificateBlobStore(config.certificateBlob)"))
      .toBeLessThan(source.indexOf("const ready = await establishWorkerReadiness"));
    expect(source.indexOf("await assertCertificateRendererReadiness()"))
      .toBeLessThan(source.indexOf("}, controller.signal, () => transition(\"ready\"))"));
  });

  it("promotes historical candidates in recurring bounded batches and stops on drain", async () => {
    const controller = new AbortController();
    const promote = vi.fn()
      .mockResolvedValueOnce({ promoted: 100 })
      .mockResolvedValueOnce({ promoted: 100 })
      .mockResolvedValueOnce({ promoted: 3 });
    const wait = vi.fn(async (delayMs: number, signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      if (promote.mock.calls.length === 3) controller.abort();
      expect(delayMs).toBe(promote.mock.calls.length < 3 ? 1_000 : 60_000);
    });
    await expect(runCertificatePromoter({ promote }, controller.signal, wait)).resolves.toBeUndefined();
    expect(promote).toHaveBeenCalledTimes(3);
    expect(promote.mock.calls).toEqual([
      [100, controller.signal],
      [100, controller.signal],
      [100, controller.signal],
    ]);
  });

  it("does not promote after shutdown and surfaces a promoter failure to supervision", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const promote = vi.fn();
    await expect(runCertificatePromoter({ promote }, stopped.signal)).resolves.toBeUndefined();
    expect(promote).not.toHaveBeenCalled();

    const failure = new Error("PROMOTER_DEPENDENCY_FAILED");
    await expect(runCertificatePromoter({ promote: vi.fn(async () => { throw failure; }) }, new AbortController().signal))
      .rejects.toBe(failure);
  });

  it("recovers absent and matching deterministic certificate objects with exact immutable observations", async () => {
    const candidate = Object.freeze({
      certificateId: "10000000-0000-4000-8000-000000000001",
      courseCompletionId: "10000000-0000-4000-8000-000000000002",
      accountId: "10000000-0000-4000-8000-000000000003",
      recoveryJobId: "10000000-0000-4000-8000-000000000004",
      failedAttempt: 1,
      failedGeneration: 2,
      recipientName: "Ada Lovelace",
      businessName: "Syntholo Test Account",
      courseTitle: "Syntholo Academy",
      courseVersion: 1,
      completedAt: "2026-08-15T12:00:00.000Z",
    });
    const bytes = new TextEncoder().encode("%PDF-1.7\nrecovery");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const objectState of ["absent", "matching"] as const) {
      const controller = new AbortController();
      const repository = {
        listStorageRetryCandidates: vi.fn(async () => [candidate]),
        retry: vi.fn(async () => ({ kind: "pending" as const })),
        rejectStorageRecovery: vi.fn(),
      };
      const reconcileUpload = objectState === "absent"
        ? vi.fn(async () => { throw new CertificateBlobError("CERTIFICATE_BLOB_NOT_FOUND", false); })
        : vi.fn(async () => ({ byteLength: bytes.byteLength, sha256, etag: "strong-etag", contentType: "application/pdf" as const }));
      const wait = vi.fn(async () => { controller.abort(); });
      await expect(runCertificateRecovery(repository, { reconcileUpload }, vi.fn(async () => bytes), controller.signal, wait))
        .resolves.toBeUndefined();
      expect(repository.retry).toHaveBeenCalledWith({
        certificateId: candidate.certificateId,
        recoveryJobId: candidate.recoveryJobId,
        failedAttempt: 1,
        failedGeneration: 2,
        objectState,
        byteLength: bytes.byteLength,
        sha256,
        etag: objectState === "absent" ? null : "strong-etag",
      }, controller.signal);
      expect(repository.rejectStorageRecovery).not.toHaveBeenCalled();
    }
  });

  it("durably suppresses terminal recovery mismatches but leaves dependency failures eligible", async () => {
    const candidate = Object.freeze({
      certificateId: "10000000-0000-4000-8000-000000000001",
      courseCompletionId: "10000000-0000-4000-8000-000000000002",
      accountId: "10000000-0000-4000-8000-000000000003",
      recoveryJobId: "10000000-0000-4000-8000-000000000004",
      failedAttempt: 1,
      failedGeneration: 2,
      recipientName: "Ada Lovelace",
      businessName: "Syntholo Test Account",
      courseTitle: "Syntholo Academy",
      courseVersion: 1,
      completedAt: "2026-08-15T12:00:00.000Z",
    });
    const bytes = new TextEncoder().encode("%PDF-1.7\nrecovery");
    for (const error of [
      new CertificateBlobError("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false),
      new CertificateBlobError("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true),
    ]) {
      const controller = new AbortController();
      const listStorageRetryCandidates = vi.fn()
        .mockResolvedValueOnce([candidate])
        .mockResolvedValueOnce([]);
      const repository = {
        listStorageRetryCandidates,
        retry: vi.fn(),
        rejectStorageRecovery: vi.fn(async () => ({ kind: "rejected" as const })),
      };
      const reconcileUpload = vi.fn(async () => { throw error; });
      let waits = 0;
      const wait = vi.fn(async () => { if (++waits === 2) controller.abort(); });
      await expect(runCertificateRecovery(repository, { reconcileUpload }, vi.fn(async () => bytes), controller.signal, wait))
        .resolves.toBeUndefined();
      expect(reconcileUpload).toHaveBeenCalledOnce();
      expect(repository.retry).not.toHaveBeenCalled();
      if (error.retryable) expect(repository.rejectStorageRecovery).not.toHaveBeenCalled();
      else expect(repository.rejectStorageRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "object_mismatch" }), controller.signal,
      );
    }

    const programmerFailure = new Error("PDF_LIBRARY_BUG_PRIVATE_DETAIL");
    const controller = new AbortController();
    const repository = {
      listStorageRetryCandidates: vi.fn(async () => [candidate]),
      retry: vi.fn(),
      rejectStorageRecovery: vi.fn(),
    };
    await expect(runCertificateRecovery(
      repository,
      { reconcileUpload: vi.fn() },
      vi.fn(async () => { throw programmerFailure; }),
      controller.signal,
    )).rejects.toBe(programmerFailure);
    expect(repository.rejectStorageRecovery).not.toHaveBeenCalled();

    const consistency = new CertificateGenerationConsistencyError();
    const consistencyRepository = {
      listStorageRetryCandidates: vi.fn(async () => [candidate]),
      retry: vi.fn(async () => { throw consistency; }),
      rejectStorageRecovery: vi.fn(),
    };
    await expect(runCertificateRecovery(
      consistencyRepository,
      { reconcileUpload: vi.fn(async () => { throw new CertificateBlobError("CERTIFICATE_BLOB_NOT_FOUND", false); }) },
      vi.fn(async () => bytes),
      new AbortController().signal,
    )).rejects.toBe(consistency);
    expect(consistencyRepository.rejectStorageRecovery).not.toHaveBeenCalled();
  });

  it("routes entitlement events without sending reconciliation into provisioning", () => {
    const base = {
      attempt: 1, claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000002",
      leaseExpiresAt: new Date(now.getTime() + 10_000), maxAttempts: 5,
      workerId: "worker-test",
    } as const;
    expect(handlersForOutboxEvent({ ...base,
      eventType: "entitlements.command_applied.v1" }))
      .toEqual(["foundation_audit_projection"]);
    expect(handlersForOutboxEvent({ ...base,
      eventType: "entitlements.reconciliation_required.v1" }))
      .toEqual(["entitlement_reconciliation_queue"]);
  });

  it.each([
    "content.lesson_published.v1",
    "content.course_published.v1",
    "content.version_archived.v1",
    "content.media_state_changed.v1",
    "content.resource_state_changed.v1",
    "content.readiness_approved.v1",
  ])("routes %s only to content readiness recomputation", (eventType) => {
    expect(handlersForOutboxEvent({
      attempt: 1,
      claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000002",
      eventType,
      leaseExpiresAt: new Date(now.getTime() + 10_000),
      maxAttempts: 5,
      workerId: "worker-test",
    })).toEqual(["content.readiness_recompute"]);
  });

  it("fans course completion out to independent certificate and implementation handlers", () => {
    expect(handlersForOutboxEvent({
      attempt: 1, claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000002",
      eventType: "learning.course_completed.v1",
      leaseExpiresAt: new Date(now.getTime() + 10_000), maxAttempts: 5, workerId: "worker-test",
    })).toEqual([
      "learning.certificate_prerequisite_record",
      "implementation.completion_recompute",
    ]);
  });

  it.each([
    "implementation.artifact_version_saved.v1",
    "implementation.program_completed.v1",
  ])("registers emitted %s for the safe audit projection", (eventType) => {
    expect(handlersForOutboxEvent({
      attempt: 1, claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000002",
      eventType,
      leaseExpiresAt: new Date(now.getTime() + 10_000), maxAttempts: 5, workerId: "worker-test",
    })).toEqual(["foundation_audit_projection"]);
  });

  it("classifies permanent routing failures and injects retry jitter", async () => {
    const controller = new AbortController();
    const claim = {
      attempt: 1,
      claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000002",
      eventType: "unknown.event.v1",
      leaseExpiresAt: new Date(now.getTime() + 10_000),
      maxAttempts: 5,
      workerId: "worker-test",
    } as const;
    const fail = vi.fn(async () => ({ kind: "dead_lettered" as const }));
    await runOutboxPump({
      clock: { now: () => now },
      config: dependencies().config,
      handlersForEvent: () => {
        throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
      },
      outbox: {
        claim: vi.fn(async () => {
          controller.abort();
          return [claim];
        }),
        dispatch: vi.fn(),
        fail,
      },
      random: () => 0.75,
      workerId: "worker-test",
    }, controller.signal);
    expect(fail).toHaveBeenCalledWith(claim, now, { permanent: true }, 0.75);
  });

  it("aborts on the first fatal pump and awaits the sibling drain", async () => {
    const controller = new AbortController();
    let drained = false;
    await expect(superviseWorkerPumps(controller, [
      async () => { throw new Error("PUMP_FATAL"); },
      async () => {
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), { once: true })
          );
        }
        await Promise.resolve();
        drained = true;
      },
    ])).rejects.toThrow("PUMP_FATAL");
    expect(controller.signal.aborted).toBe(true);
    expect(drained).toBe(true);
  });

  it("forces nonzero termination after a bounded fatal pump and close window", async () => {
    const controller = new AbortController();
    const never = new Promise<void>(() => undefined);
    const close = vi.fn(async () => never);
    const abortActive = vi.fn();
    const forceTerminate = vi.fn();
    const fatalDrainWait = vi.fn(async () => undefined);

    await expect(superviseWorkerPumps(controller, [
      async () => { throw new Error("PUMP_FATAL"); },
      async () => never,
    ], {
      abortActive,
      close,
      fatalDrainTimeoutMs: 25,
      fatalDrainWait,
      forceTerminate,
    })).rejects.toThrow("PUMP_FATAL");

    expect(controller.signal.aborted).toBe(true);
    expect(abortActive).toHaveBeenCalledTimes(1);
    expect(fatalDrainWait).toHaveBeenCalledWith(25, expect.any(AbortSignal));
    expect(close).not.toHaveBeenCalled();
    expect(forceTerminate).toHaveBeenCalledWith(1);
  });

  it("forces nonzero termination when fatal siblings drain but pool close hangs", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => new Promise<void>(() => undefined));
    const forceTerminate = vi.fn();
    const fatalDrainWait = vi.fn(async () => undefined);

    await expect(superviseWorkerPumps(controller, [
      async () => { throw new Error("PUMP_FATAL"); },
      async () => {
        while (!controller.signal.aborted) await Promise.resolve();
      },
    ], {
      close,
      fatalDrainTimeoutMs: 25,
      fatalDrainWait,
      forceTerminate,
    })).rejects.toThrow("PUMP_FATAL");

    expect(close).toHaveBeenCalledTimes(1);
    expect(fatalDrainWait).toHaveBeenCalledTimes(1);
    expect(forceTerminate).toHaveBeenCalledWith(1);
  });

  it("treats uncertain receipt transitions as fatal and retries only after confirmed abandon", async () => {
    const job = {
      accountId: null,
      attempt: 1,
      claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000001",
      correlationId: "10000000-0000-4000-8000-000000000002",
      id: "10000000-0000-4000-8000-000000000003",
      idempotencyKey: "event:test",
      leaseExpiresAt: new Date(now.getTime() + 10_000),
      maxAttempts: 5,
      payload: {
        eventId: "10000000-0000-4000-8000-000000000004",
        handlerName: "foundation_audit_projection",
      },
      sourceActorId: "source",
      sourceActorType: "system",
      type: "foundation.domain_event_handler.v1",
      workerId: "worker-test",
    } as ClaimedJob;
    const receipt = {
      accountId: null,
      attempt: 1,
      claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000005",
      eventId: job.payload.eventId,
      handlerName: job.payload.handlerName,
      jobAttempt: 1,
      jobClaimGeneration: 1,
      jobClaimToken: job.claimToken,
      jobId: job.id,
      kind: "acquired",
      leaseExpiresAt: job.leaseExpiresAt,
      workerId: job.workerId,
    } as HandlerReceiptClaim;
    await expect(createDomainEventJobHandler({
      acquire: vi.fn(async () => { throw new Error("uncertain"); }),
      abandon: vi.fn(),
      complete: vi.fn(),
    }, { now: () => now })(job, new AbortController().signal))
      .rejects.toBeInstanceOf(FatalWorkerConsistencyError);

    await expect(createDomainEventJobHandler({
      acquire: vi.fn(async () => ({
        kind: "busy" as const,
        leaseExpiresAt: job.leaseExpiresAt,
      })),
      abandon: vi.fn(),
      complete: vi.fn(),
    }, { now: () => now })(job, new AbortController().signal))
      .rejects.toMatchObject({
        failure: {
          code: "JOB_DEPENDENCY_UNAVAILABLE",
          permanent: false,
          retryAt: job.leaseExpiresAt,
        },
      });

    const abandon = vi.fn(async () => ({ kind: "abandoned" as const }));
    await expect(createDomainEventJobHandler({
      acquire: vi.fn(async () => receipt),
      abandon,
      complete: vi.fn(async () => { throw new Error("effect unavailable"); }),
    }, { now: () => now })(job, new AbortController().signal))
      .rejects.toThrow("effect unavailable");
    expect(abandon).toHaveBeenCalledTimes(1);

    await expect(createDomainEventJobHandler({
      acquire: vi.fn(async () => receipt),
      abandon: vi.fn(async () => { throw new Error("uncertain"); }),
      complete: vi.fn(async () => { throw new Error("effect unavailable"); }),
    }, { now: () => now })(job, new AbortController().signal))
      .rejects.toBeInstanceOf(FatalWorkerConsistencyError);
  });

  it("invokes the exact named domain handler before completing its receipt", async () => {
    const job = {
      accountId: null,
      attempt: 1,
      claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000001",
      correlationId: "10000000-0000-4000-8000-000000000002",
      id: "10000000-0000-4000-8000-000000000003",
      idempotencyKey: "event:test",
      leaseExpiresAt: new Date(now.getTime() + 10_000),
      maxAttempts: 5,
      payload: {
        eventId: "10000000-0000-4000-8000-000000000004",
        handlerName: "content.readiness_recompute",
      },
      sourceActorId: "source",
      sourceActorType: "system",
      type: "foundation.domain_event_handler.v1",
      workerId: "worker-test",
    } as ClaimedJob;
    const receipt = {
      accountId: null,
      attempt: 1,
      claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000005",
      eventId: job.payload.eventId,
      handlerName: job.payload.handlerName,
      jobAttempt: 1,
      jobClaimGeneration: 1,
      jobClaimToken: job.claimToken,
      jobId: job.id,
      kind: "acquired",
      leaseExpiresAt: job.leaseExpiresAt,
      workerId: job.workerId,
    } as HandlerReceiptClaim;
    const sequence: string[] = [];
    const domainHandler = vi.fn(async () => { sequence.push("effect"); });
    const complete = vi.fn(async () => {
      sequence.push("receipt");
      return { kind: "completed" as const };
    });

    await createDomainEventJobHandler({
      acquire: vi.fn(async () => receipt),
      abandon: vi.fn(),
      complete,
    }, { now: () => now }, {
      "content.readiness_recompute": domainHandler,
    })(job, new AbortController().signal);

    expect(domainHandler).toHaveBeenCalledWith({
      eventId: job.payload.eventId,
      handlerName: job.payload.handlerName,
    }, expect.any(AbortSignal));
    expect(sequence).toEqual(["effect", "receipt"]);
  });

  it("rejects an inexact domain-event job payload before claiming a receipt", async () => {
    const acquire = vi.fn();
    const handler = createDomainEventJobHandler({
      acquire,
      abandon: vi.fn(),
      complete: vi.fn(),
    }, { now: () => now }, {
      "content.readiness_recompute": vi.fn(),
    });
    await expect(handler({
      accountId: null, attempt: 1, claimGeneration: 1,
      claimToken: "10000000-0000-4000-8000-000000000001",
      correlationId: "10000000-0000-4000-8000-000000000002",
      id: "10000000-0000-4000-8000-000000000003",
      idempotencyKey: "event:test",
      leaseExpiresAt: new Date(now.getTime() + 10_000), maxAttempts: 5,
      payload: {
        eventId: "10000000-0000-4000-8000-000000000004",
        handlerName: "content.readiness_recompute",
        providerBody: "forbidden",
      },
      sourceActorId: "source", sourceActorType: "system",
      type: "foundation.domain_event_handler.v1", workerId: "worker-test",
    } as ClaimedJob, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: "JOB_INPUT_INVALID", permanent: true },
    });
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe("compiled worker artifacts", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, RELEASE_SHA: releaseSha },
    });
  });

  it.each(["runner.js", "cron.js"])(
    "produces executable %s and fails startup closed",
    async (filename) => {
      const artifact = new URL(`../dist/${filename}`, import.meta.url);
      await expect(access(artifact)).resolves.toBeUndefined();
      await expect(readFile(artifact, "utf8")).resolves.toContain(releaseSha);
      await expect(
        execFileAsync(process.execPath, [artifact.pathname], {
          env: { PATH: process.env.PATH },
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: "WORKER_STARTUP_FAILED\n",
      });
    },
  );

  it("fails built renderer readiness for each missing or corrupt authority asset", async () => {
    for (const mutation of ["missing", "corrupt"] as const) {
      const directory = await mkdtemp(join(tmpdir(), `syntholo-certificate-${mutation}-`));
      try {
        await cp(new URL("../dist", import.meta.url), directory, { recursive: true });
        const font = join(directory, "assets", "unifont-15.0.04.ttf");
        if (mutation === "missing") await rm(font);
        else await writeFile(font, new Uint8Array([0, 1, 2, 3]));
        const renderer = await import(`${pathToFileURL(join(directory, "certificate-render.js")).href}?${mutation}`);
        await expect(renderer.assertCertificateRendererReadiness())
          .rejects.toThrow("CERTIFICATE_RENDER_FONT_AUTHORITY_INVALID");
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  });

  it("fails the built worker before readiness when deployment and Blob store authority disagree", async () => {
    const artifact = new URL("../dist/runner.js", import.meta.url);
    await expect(execFileAsync(process.execPath, [artifact.pathname], {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: "postgres://worker:private@example.invalid/database",
        RELEASE_SHA: releaseSha,
        WORKER_CONCURRENCY: "2",
        CERTIFICATE_BLOB_ENABLED: "true",
        DEPLOYMENT_ENVIRONMENT: "production",
        CERTIFICATE_BLOB_ENVIRONMENT: "staging",
        CERTIFICATE_BLOB_TOKEN: "vercel_blob_rw_stagingcertificates_abcdefghijklmnopqrstuvwxyz012345",
        CERTIFICATE_BLOB_STAGING_STORE_ID: "stagingcertificates",
        CERTIFICATE_BLOB_PRODUCTION_STORE_ID: "productioncertificates",
      },
    })).rejects.toMatchObject({
      code: 1,
      stderr: "WORKER_STARTUP_FAILED\n",
    });
  });
});
