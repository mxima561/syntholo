import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { academyCourse } from "@syntholo/domain";
import { safeJobErrorCode, safeJobErrorMessage } from "./outbox";

const TEST_DATABASE_URL = "postgresql://syntholo@localhost:54329/syntholo_test";

async function probeScratchDatabase(): Promise<boolean> {
  const probe = postgres(TEST_DATABASE_URL, { connect_timeout: 2, max: 1, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
}

const canReachScratchDatabase = await probeScratchDatabase();

describe("safe job errors", () => {
  it("truncates messages and collapses whitespace", () => {
    expect(safeJobErrorMessage(`${"secret-stack\n".repeat(80)}`).length).toBe(500);
    expect(safeJobErrorMessage("line1\nline2\tline3")).toBe("line1 line2 line3");
  });

  it("keeps a short error code", () => {
    expect(safeJobErrorCode("JOB_FAILED")).toBe("JOB_FAILED");
    expect(safeJobErrorCode("x".repeat(80)).length).toBe(64);
  });
});

describe.skipIf(!canReachScratchDatabase)("audit, outbox, and skip-locked jobs", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { getReadyDb } = await import("./client");
    await getReadyDb();
  });

  afterAll(async () => {
    if (!canReachScratchDatabase) return;
    const { closeDb } = await import("./client");
    await closeDb();
  });

  async function createUser(email: string) {
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const [row] = await db`
      INSERT INTO app_users (email, first_name, last_name, role)
      VALUES (${email}, ${"Outbox"}, ${"Tester"}, ${"student"})
      ON CONFLICT (email) DO UPDATE SET first_name = EXCLUDED.first_name
      RETURNING id
    `;
    return String(row.id);
  }

  it("rolls back audit and outbox when mutateWithEvent throws", async () => {
    const { appendAudit, enqueueJob, enqueueOutbox, mutateWithEvent } = await import("./index");
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const marker = `rollback-${Date.now()}`;

    await expect(
      mutateWithEvent(async (tx) => {
        await appendAudit(tx, {
          actorKind: "system",
          actorId: "test",
          action: marker,
          targetType: "test",
          targetId: marker,
          payload: { marker },
        });
        await enqueueOutbox(tx, {
          eventName: "job.requested.v1",
          payload: { marker },
        });
        await enqueueJob(tx, { kind: "test.rollback", payload: { marker } });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const audits = await db`SELECT id FROM audit_events WHERE action = ${marker} AND target_id = ${marker}`;
    const outbox = await db`SELECT id FROM outbox_events WHERE payload->>'marker' = ${marker}`;
    const jobs = await db`SELECT id FROM jobs WHERE kind = ${"test.rollback"} AND payload->>'marker' = ${marker}`;
    expect(audits).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it("writes audit and outbox with a committed grant mutation", async () => {
    const { ensureAccountForUser, grantCourseEntitlement, withSystemScope } = await import("./index");
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const userId = await createUser(`grant-audit-${Date.now()}@syntholo.test`);
    const membership = await withSystemScope((sql) => ensureAccountForUser(userId, {}, sql));

    const granted = await grantCourseEntitlement(userId, academyCourse.id);
    expect(granted.capabilities.academy_course).toBe(true);

    const audits = await db`
      SELECT action, target_id FROM audit_events
      WHERE action = ${"entitlement.granted"} AND target_id = ${membership.accountId}
    `;
    const outbox = await db`
      SELECT event_name, id FROM outbox_events
      WHERE event_name = ${"entitlement.granted.v1"} AND account_id = ${membership.accountId}
    `;
    expect(audits.length).toBeGreaterThan(0);
    expect(outbox.length).toBeGreaterThan(0);
    const jobs = await db`
      SELECT kind FROM jobs WHERE kind = ${"outbox.publish"} AND payload->>'outboxId' = ${String(outbox[0].id)}
    `;
    expect(jobs).toHaveLength(1);
  });

  it("claims each queued job once across two workers", async () => {
    const { claimJobs, enqueueJob, withSystemScope } = await import("./index");
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const now = new Date();
    const farFuture = new Date("2099-01-01T00:00:00.000Z");
    const stamp = `claim-${Date.now()}`;

    await withSystemScope(async (sql) => {
      await sql`UPDATE jobs SET run_at = ${farFuture} WHERE status = ${"queued"}`;
      for (let index = 0; index < 10; index += 1) {
        await enqueueJob(sql, { kind: stamp, payload: { index }, runAt: now });
      }
    });

    const workerA = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 5 });
    const workerB = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 5 });
    try {
      const [claimedA, claimedB] = await Promise.all([
        workerA.begin((tx) =>
          claimJobs(tx as unknown as typeof db, { limit: 10, workerId: "worker-a", now }),
        ),
        workerB.begin((tx) =>
          claimJobs(tx as unknown as typeof db, { limit: 10, workerId: "worker-b", now }),
        ),
      ]);
      const claimed = [...claimedA, ...claimedB].filter((job) => job.kind === stamp);
      const ids = claimed.map((job) => job.id);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
      expect(claimedA.filter((job) => job.kind === stamp).some((job) => claimedB.some((other) => other.id === job.id))).toBe(
        false,
      );
    } finally {
      await workerA.end({ timeout: 1 }).catch(() => undefined);
      await workerB.end({ timeout: 1 }).catch(() => undefined);
    }
  });

  it("dead-letters a job after max_attempts and keeps the error code", async () => {
    const { enqueueJob, failJob, withSystemScope } = await import("./index");
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const now = new Date();
    const job = await withSystemScope((sql) =>
      enqueueJob(sql, { kind: "test.fail", payload: { reason: "boom" }, maxAttempts: 3, runAt: now }),
    );

    await withSystemScope(async (sql) => {
      await failJob(sql, job.id, { code: "TEST_FAIL", message: "first", now });
      await failJob(sql, job.id, { code: "TEST_FAIL", message: "second", now });
      await failJob(sql, job.id, { code: "TEST_FAIL", message: "third", now });
    });

    const [row] = await db`
      SELECT status, attempt, last_error_code, last_error_message FROM jobs WHERE id = ${job.id}
    `;
    expect(row.status).toBe("dead_letter");
    expect(Number(row.attempt)).toBe(3);
    expect(row.last_error_code).toBe("TEST_FAIL");
    expect(row.last_error_message).toBe("third");
  });

  it("rejects UPDATE and DELETE on audit_events", async () => {
    const { appendAudit, mutateWithEvent } = await import("./index");
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const marker = `append-only-${Date.now()}`;
    const { id } = await mutateWithEvent((tx) =>
      appendAudit(tx, {
        actorKind: "system",
        actorId: "test",
        action: marker,
        targetType: "test",
        targetId: marker,
        payload: {},
      }),
    );

    await expect(db`UPDATE audit_events SET action = ${"mutated"} WHERE id = ${id}`).rejects.toMatchObject({
      message: expect.stringMatching(/append-only/i),
    });
    await expect(db`DELETE FROM audit_events WHERE id = ${id}`).rejects.toMatchObject({
      message: expect.stringMatching(/append-only/i),
    });
    const [row] = await db`SELECT action FROM audit_events WHERE id = ${id}`;
    expect(row.action).toBe(marker);
  });
});
