import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  acquireMemberReadClient,
  isMemberReadDeadlineError,
  runMemberReadLockQuery,
  runMemberReadQuery,
} from "./member-read-deadlines.js";

const pools: Pool[] = [];

function realPool(max = 1): Pool {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (connectionString === undefined) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const pool = new Pool({
    application_name: "syntholo-member-deadline-integration",
    connectionString,
    max,
  });
  pools.push(pool);
  return pool;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("TEST_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((pool) => pool.end()));
});

describe.sequential("real pg member read deadline disposal", () => {
  it("destroys an acquired lease when the parent is already expired, runs no SQL, and keeps the following request healthy", async () => {
    const pool = realPool();
    const lease = await acquireMemberReadClient(
      pool,
      performance.now() + 1_000,
      performance.now() + 1_000,
    );
    await expect(runMemberReadQuery(
      lease,
      performance.now() + 1_000,
      performance.now() - 1,
      "select pg_sleep(5)",
    )).rejects.toMatchObject({ kind: "parent_timeout" });
    expect(lease.destroyed).toBe(true);
    await expect(pool.query("select 1::int value"))
      .resolves.toMatchObject({ rows: [{ value: 1 }] });
    expect(pool.totalCount).toBe(1);
  });

  it("destroys a late one-client-pool checkout and keeps the following request healthy", async () => {
    const pool = realPool();
    const blocker = await pool.connect();
    const acquisition = acquireMemberReadClient(
      pool,
      performance.now() + 100,
      performance.now() + 1_000,
    );
    await expect(acquisition).rejects.toMatchObject({ kind: "pool_acquire_timeout" });
    blocker.release();
    await waitUntil(() => pool.waitingCount === 0);
    await expect(pool.query("select 1::int value"))
      .resolves.toMatchObject({ rows: [{ value: 1 }] });
    expect(pool.totalCount).toBe(1);
  });

  it.each([
    ["query_timeout", 100, 1_000, runMemberReadQuery],
    ["parent_timeout", 1_000, 100, runMemberReadQuery],
    ["lock_timeout", 100, 1_000, runMemberReadLockQuery],
  ] as const)("destroys an active pg 8.23 lease on %s and allows a following query", async (
    kind,
    operationBudget,
    parentBudget,
    run,
  ) => {
    const pool = realPool();
    const lease = await acquireMemberReadClient(
      pool,
      performance.now() + 1_000,
      performance.now() + 1_000,
    );
    await expect(run(
      lease,
      performance.now() + operationBudget,
      performance.now() + parentBudget,
      "select pg_sleep(5)",
      [],
      1_000,
    )).rejects.toMatchObject({ kind });
    expect(lease.destroyed).toBe(true);
    await expect(pool.query("select 1::int value"))
      .resolves.toMatchObject({ rows: [{ value: 1 }] });
    expect(pool.totalCount).toBe(1);
  });

  it("does not translate a real raw 57014 and returns its lease normally", async () => {
    const pool = realPool();
    const lease = await acquireMemberReadClient(
      pool,
      performance.now() + 1_000,
      performance.now() + 1_000,
    );
    await lease.client.query("set statement_timeout='50ms'");
    let raw: unknown;
    try {
      await runMemberReadQuery(
        lease,
        performance.now() + 1_000,
        performance.now() + 1_000,
        "select pg_sleep(1)",
      );
    } catch (error) {
      raw = error;
    }
    expect(raw).toMatchObject({ code: "57014" });
    expect(isMemberReadDeadlineError(raw)).toBe(false);
    await lease.client.query("set statement_timeout=0");
    lease.release();
    await expect(pool.query("select 1::int value"))
      .resolves.toMatchObject({ rows: [{ value: 1 }] });
  });
});
