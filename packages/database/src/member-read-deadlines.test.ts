import { describe, expect, it, vi } from "vitest";

type Listener = () => void;

function clientFixture() {
  const listeners = new Map<string, Listener>();
  const release = vi.fn((destroy?: boolean) => {
    if (destroy) listeners.get("end")?.();
  });
  return {
    client: {
      query: vi.fn(async () => ({ rows: [{ ok: true }] })),
      release,
      once: vi.fn((event: string, listener: Listener) => {
        listeners.set(event, listener);
      }),
    },
    release,
  };
}

describe("member read deadlines", () => {
  it("times out pool acquisition with its nominal sentinel and destroys a late client", async () => {
    vi.useFakeTimers();
    try {
      let deliver!: (client: ReturnType<typeof clientFixture>["client"]) => void;
      const connect = new Promise<ReturnType<typeof clientFixture>["client"]>((resolve) => {
        deliver = resolve;
      });
      const { acquireMemberReadClient } = await import("./member-read-deadlines.js");
      const acquisition = acquireMemberReadClient(
        { connect: () => connect } as never,
        performance.now() + 10,
        performance.now() + 100,
      );
      const rejected = expect(acquisition).rejects.toMatchObject({ kind: "pool_acquire_timeout" });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;

      const late = clientFixture();
      deliver(late.client);
      await Promise.resolve();
      await Promise.resolve();
      expect(late.release).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the parent sentinel when the operation budget wins acquisition", async () => {
    vi.useFakeTimers();
    try {
      const { acquireMemberReadClient } = await import("./member-read-deadlines.js");
      const acquisition = acquireMemberReadClient(
        { connect: () => new Promise(() => undefined) } as never,
        performance.now() + 100,
        performance.now() + 5,
      );
      const rejected = expect(acquisition).rejects.toMatchObject({ kind: "parent_timeout" });
      await vi.advanceTimersByTimeAsync(5);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys a query-timeout lease once and waits for query settlement", async () => {
    vi.useFakeTimers();
    try {
      let rejectQuery!: (error: Error) => void;
      const rawQuery = new Promise<never>((_resolve, reject) => {
        rejectQuery = reject;
      });
      const fixture = clientFixture();
      fixture.client.query.mockReturnValueOnce(rawQuery);
      const { acquireMemberReadClient, runMemberReadQuery } = await import("./member-read-deadlines.js");
      const lease = await acquireMemberReadClient(
        { connect: async () => fixture.client } as never,
        performance.now() + 100,
        performance.now() + 100,
      );
      let settled = false;
      const query = runMemberReadQuery(
        lease,
        performance.now() + 10,
        performance.now() + 100,
        "select pg_sleep(10)",
        [],
        1_000,
      ).finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(10);
      expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(settled).toBe(false);
      rejectQuery(new Error("socket closed"));
      await expect(query).rejects.toMatchObject({ kind: "query_timeout" });
      expect(fixture.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("translates only real repository-owned sentinels", async () => {
    vi.useFakeTimers();
    try {
      const {
        acquireMemberReadClient,
        DatabaseDependencyUnavailableError,
        translateMemberReadDependencyError,
      } = await import("./member-read-deadlines.js");
      const acquisition = acquireMemberReadClient(
        { connect: () => new Promise(() => undefined) } as never,
        performance.now() + 1,
        performance.now() + 100,
      );
      const sentinelPromise = acquisition.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1);
      const sentinel = await sentinelPromise;
      expect(sentinel).toBeInstanceOf(Error);
      if (!(sentinel instanceof Error) || !("kind" in sentinel)) {
        throw new Error("EXPECTED_MEMBER_READ_SENTINEL");
      }

      expect(translateMemberReadDependencyError(sentinel))
        .toBeInstanceOf(DatabaseDependencyUnavailableError);
      expect(() => translateMemberReadDependencyError({
        name: sentinel.name,
        message: sentinel.message,
        kind: sentinel.kind,
      })).toThrow("MEMBER_READ_DEPENDENCY_ERROR_NOT_TRANSLATABLE");
      for (const raw of [
        Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014", kind: "query_timeout",
        }),
        Object.assign(new Error("timeout exceeded when trying to connect"), {
          code: "ETIMEDOUT",
        }),
        Object.assign(new Error("remaining connection slots are reserved"), {
          code: "53300",
        }),
        Object.assign(new Error("connection terminated unexpectedly"), {
          code: "57P01",
        }),
      ]) {
        expect(() => translateMemberReadDependencyError(raw))
          .toThrow("MEMBER_READ_DEPENDENCY_ERROR_NOT_TRANSLATABLE");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an ordinary successful lease exactly once", async () => {
    const fixture = clientFixture();
    const { acquireMemberReadClient, runMemberReadQuery } = await import("./member-read-deadlines.js");
    const lease = await acquireMemberReadClient(
      { connect: async () => fixture.client } as never,
      performance.now() + 100,
      performance.now() + 100,
    );
    await expect(runMemberReadQuery(
      lease,
      performance.now() + 100,
      performance.now() + 100,
      "select 1",
      [],
    )).resolves.toEqual({ rows: [{ ok: true }] });
    lease.release();
    lease.release();
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.release).toHaveBeenCalledWith();
  });

  it("clears its deadline timer when the raw query rejects first", async () => {
    vi.useFakeTimers();
    try {
      const fixture = clientFixture();
      const rawFailure = Object.assign(new Error("driver failure"), { code: "57014" });
      fixture.client.query.mockRejectedValueOnce(rawFailure);
      const { acquireMemberReadClient, runMemberReadQuery } = await import("./member-read-deadlines.js");
      const lease = await acquireMemberReadClient(
        { connect: async () => fixture.client } as never,
        performance.now() + 100,
        performance.now() + 100,
      );

      await expect(runMemberReadQuery(
        lease,
        performance.now() + 50,
        performance.now() + 100,
        "select 1",
      )).rejects.toBe(rawFailure);
      expect(vi.getTimerCount()).toBe(0);
      expect(fixture.release).not.toHaveBeenCalled();
      lease.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its cleanup timer when rollback or unlock rejects first", async () => {
    vi.useFakeTimers();
    try {
      const fixture = clientFixture();
      const rawFailure = new Error("cleanup failed");
      fixture.client.query.mockRejectedValueOnce(rawFailure);
      const {
        acquireMemberReadClient,
        runMemberReadCleanupQuery,
      } = await import("./member-read-deadlines.js");
      const lease = await acquireMemberReadClient(
        { connect: async () => fixture.client } as never,
        performance.now() + 100,
        performance.now() + 100,
      );

      await expect(runMemberReadCleanupQuery(
        lease,
        50,
        "rollback",
      )).rejects.toBe(rawFailure);
      expect(vi.getTimerCount()).toBe(0);
      lease.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds destruction acknowledgement when pg never emits end", async () => {
    vi.useFakeTimers();
    try {
      const fixture = clientFixture();
      fixture.release.mockImplementation(() => undefined);
      const {
        acquireMemberReadClient,
        destroyMemberReadLease,
      } = await import("./member-read-deadlines.js");
      const lease = await acquireMemberReadClient(
        { connect: async () => fixture.client } as never,
        performance.now() + 100,
        performance.now() + 100,
      );
      let settled = false;
      const destroyed = destroyMemberReadLease(lease, 50)
        .finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await destroyed;
      expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("poisons an acquired lease when the parent deadline is already expired before a query", async () => {
    vi.useFakeTimers();
    try {
      const fixture = clientFixture();
      fixture.release.mockImplementation(() => undefined);
      const { acquireMemberReadClient, runMemberReadQuery } = await import("./member-read-deadlines.js");
      const lease = await acquireMemberReadClient(
        { connect: async () => fixture.client } as never,
        performance.now() + 100,
        performance.now() + 100,
      );
      const pending = runMemberReadQuery(
        lease,
        performance.now() + 100,
        performance.now() - 1,
        "select must_not_run()",
        [],
        50,
      );
      const rejected = expect(pending).rejects.toMatchObject({ kind: "parent_timeout" });

      await vi.advanceTimersByTimeAsync(49);
      expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(fixture.client.query).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(lease.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
