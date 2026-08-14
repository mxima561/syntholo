import { describe, expect, it, vi } from "vitest";
import { runFoundationCron, startCron } from "./cron";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";
const environment = {
  DATABASE_URL: "postgres://worker:password@example.test/db",
  RELEASE_SHA: releaseSha,
  WORKER_CONCURRENCY: "1",
};
const fastTimeouts = {
  closeMs: 10,
  connectMs: 10,
  queryMs: 10,
  unlockMs: 10,
  workMs: 10,
};

describe("one-shot cron", () => {
  it("runs exactly once and resolves only after completion", async () => {
    const run = vi.fn(async () => undefined);
    await startCron({
      env: environment,
      lifecycle: { run },
      signal: new AbortController().signal,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ releaseSha }),
      expect.any(AbortSignal),
    );
  });

  it("propagates a failed one-shot run for a nonzero process exit", async () => {
    await expect(startCron({
      env: environment,
      lifecycle: { run: async () => { throw new Error("CRON_FAILED"); } },
      signal: new AbortController().signal,
    })).rejects.toThrow("CRON_FAILED");
  });

  it("runs fixed-limit staff-auth cleanup under one advisory lock", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({
        rows: [{ login_attempts_deleted: 2, sessions_deleted: 1 }],
      })
      .mockResolvedValueOnce({ rows: [{ released: true }] });
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));
    const checkReadiness = vi.fn(async () => ({
      latencyMs: 1,
      status: "ok" as const,
    }));

    await expect(runFoundationCron(
      { pool: { connect } },
      checkReadiness,
      new AbortController().signal,
      fastTimeouts,
    )).resolves.toEqual({
      loginAttemptsDeleted: 2,
      sessionsDeleted: 1,
      status: "completed",
    });

    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[0]).toMatchObject({
      query_timeout: fastTimeouts.queryMs,
      text: expect.stringContaining("cleanup_staff_auth(statement_timestamp(), $1)"),
      values: [500],
    });
    expect(release).toHaveBeenCalledWith(false);
  });

  it("treats an overlapping cron as a successful no-op", async () => {
    const checkReadiness = vi.fn();
    const release = vi.fn();
    await expect(runFoundationCron(
      { pool: { connect: async () => ({
        query: async () => ({ rows: [{ acquired: false }] }),
        release,
      }) } },
      checkReadiness,
      new AbortController().signal,
      fastTimeouts,
    )).resolves.toEqual({ status: "already-running" });
    expect(checkReadiness).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(false);
  });

  it("propagates abort to in-flight work and destroys the database client", async () => {
    const controller = new AbortController();
    const release = vi.fn();
    let workStarted!: () => void;
    const started = new Promise<void>((resolve) => { workStarted = resolve; });
    const pending = runFoundationCron(
      { pool: { connect: async () => ({
        query: async () => ({ rows: [{ acquired: true }] }),
        release,
      }) } },
      async (signal) => {
        workStarted();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      },
      controller.signal,
      fastTimeouts,
    );

    await started;
    controller.abort();
    await expect(pending).rejects.toThrow("CRON_ABORTED");
    expect(release).toHaveBeenCalledWith(true);
  });

  it("enforces a hard work timeout", async () => {
    const release = vi.fn();
    const pending = runFoundationCron(
      { pool: { connect: async () => ({
        query: async () => ({ rows: [{ acquired: true }] }),
        release,
      }) } },
      async () => new Promise(() => undefined),
      new AbortController().signal,
      fastTimeouts,
    );
    const observed = Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("TEST_NO_TIMEOUT")), 50)),
    ]);

    await expect(observed).rejects.toThrow("CRON_WORK_TIMEOUT");
    expect(release).toHaveBeenCalledWith(true);
  });

  it("enforces the shorter database timeout during maintenance", async () => {
    const release = vi.fn();
    let calls = 0;
    const pending = runFoundationCron(
      { pool: { connect: async () => ({
        query: async () => {
          calls += 1;
          if (calls === 1) return { rows: [{ acquired: true }] };
          return new Promise(() => undefined);
        },
        release,
      }) } },
      async () => undefined,
      new AbortController().signal,
      { ...fastTimeouts, queryMs: 5, workMs: 30 },
    );

    await expect(pending).rejects.toThrow("CRON_DATABASE_TIMEOUT");
    expect(release).toHaveBeenCalledWith(true);
  });

  it("bounds unlock and database close", async () => {
    const release = vi.fn();
    let calls = 0;
    await expect(runFoundationCron(
      { pool: { connect: async () => ({
        query: async () => {
          calls += 1;
          if (calls === 1) return { rows: [{ acquired: true }] };
          if (calls === 2) {
            return { rows: [{ login_attempts_deleted: 0, sessions_deleted: 0 }] };
          }
          return new Promise(() => undefined);
        },
        release,
      }) } },
      async () => undefined,
      new AbortController().signal,
      fastTimeouts,
    )).rejects.toThrow("CRON_UNLOCK_TIMEOUT");
    expect(release).toHaveBeenCalledWith(true);

    const cronModule = await import("./cron") as unknown as {
      closeCronDatabase?: (
        close: () => Promise<void>,
        timeoutMs: number,
      ) => Promise<void>;
    };
    expect(cronModule.closeCronDatabase).toBeTypeOf("function");
    await expect(cronModule.closeCronDatabase?.(
      async () => new Promise(() => undefined),
      fastTimeouts.closeMs,
    )).rejects.toThrow("CRON_CLOSE_TIMEOUT");
  });
});
