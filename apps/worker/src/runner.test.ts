import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseWorkerConfig } from "./config.js";
import {
  createDomainEventJobHandler,
  runOutboxPump,
  runWorker,
  createWorkerId,
  startWorker,
  superviseWorkerPumps,
  type WorkerDependencies,
  type WorkerJob,
} from "./runner.js";
import { FatalWorkerConsistencyError, HandlerFailure } from "./handlers/index.js";
import type { ClaimedJob, HandlerReceiptClaim } from "@syntholo/database";

const execFileAsync = promisify(execFile);
const now = new Date("2026-08-13T12:00:00.000Z");

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
      releaseSha: "test-release",
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
  });
  it("parses and preserves validated worker startup values", () => {
    expect(
      parseWorkerConfig({
        DATABASE_URL: "  postgres://worker:password@example.test/db  ",
        RELEASE_SHA: "  release-worker  ",
        WORKER_CONCURRENCY: "4",
        WORKER_IDLE_DELAY_MS: "750",
      }),
    ).toEqual({
      databaseUrl: "postgres://worker:password@example.test/db",
      releaseSha: "release-worker",
      concurrency: 4,
      idleDelayMs: 750,
    });
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
        releaseSha: "test-release",
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
          releaseSha: "test-release",
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
          releaseSha: "test-release",
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
});

describe("compiled worker artifacts", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"], {
      cwd: new URL("..", import.meta.url),
    });
  });

  it.each(["runner.js", "cron.js"])(
    "produces executable %s and fails startup closed",
    async (filename) => {
      const artifact = new URL(`../dist/${filename}`, import.meta.url);
      await expect(access(artifact)).resolves.toBeUndefined();
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
});
