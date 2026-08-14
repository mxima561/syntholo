import { describe, expect, it, vi } from "vitest";
import { runFoundationCron, startCron } from "./cron";

const releaseSha = "0123456789abcdef0123456789abcdef01234567";
const environment = {
  DATABASE_URL: "postgres://worker:password@example.test/db",
  RELEASE_SHA: releaseSha,
  WORKER_CONCURRENCY: "1",
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

  it("uses one PostgreSQL advisory lock and always releases it", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ released: true }] });
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));
    const checkReadiness = vi.fn(async () => ({ latencyMs: 1, status: "ok" as const }));

    await runFoundationCron(
      { pool: { connect } },
      checkReadiness,
      new AbortController().signal,
    );

    expect(checkReadiness).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects an overlapping cron without doing work", async () => {
    const checkReadiness = vi.fn();
    const release = vi.fn();
    await expect(runFoundationCron(
      { pool: { connect: async () => ({
        query: async () => ({ rows: [{ acquired: false }] }),
        release,
      }) } },
      checkReadiness,
      new AbortController().signal,
    )).rejects.toThrow("CRON_ALREADY_RUNNING");
    expect(checkReadiness).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
