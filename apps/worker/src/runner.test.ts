import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseWorkerConfig } from "./config.js";
import {
  runWorker,
  startWorker,
  type WorkerDependencies,
  type WorkerJob,
} from "./runner.js";

const execFileAsync = promisify(execFile);
const now = new Date("2026-08-13T12:00:00.000Z");

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
    jobs: { claim: vi.fn(async () => []) },
    handlers: {
      handle: vi.fn(async (job: WorkerJob) => {
        void job;
      }),
    },
    ...patch,
  };
}

describe("worker configuration and startup", () => {
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
          jobs: { claim },
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

    await runWorker(dependencies({ jobs: { claim }, wait }), controller.signal);

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
      jobs: { claim },
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
        jobs: { claim },
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
        jobs: { claim },
      }),
      controller.signal,
    );

    while (claim.mock.calls.length === 0) await Promise.resolve();
    controller.abort();
    await running;

    expect(claim).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
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
