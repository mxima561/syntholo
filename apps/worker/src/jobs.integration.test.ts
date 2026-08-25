import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorker } from "./app";
import { defaultJobHandlers } from "./handlers/index";
import { processJobBatch } from "./jobs";

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

describe.skipIf(!canReachScratchDatabase)("worker job processing", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { getReadyDb } = await import("@syntholo/db");
    await getReadyDb();
  });

  afterAll(async () => {
    if (!canReachScratchDatabase) return;
    const { closeDb } = await import("@syntholo/db");
    await closeDb();
  });

  it("publishes an outbox event through outbox.publish", async () => {
    const { enqueueOutbox, mutateWithEvent } = await import("@syntholo/db");
    const marker = `worker-publish-${Date.now()}`;
    const { id } = await mutateWithEvent((db) =>
      enqueueOutbox(db, { eventName: "job.requested.v1", payload: { marker } }),
    );

    let publishedAt: Date | null = null;
    for (let attempt = 0; attempt < 8 && !publishedAt; attempt += 1) {
      await processJobBatch({
        workerId: "worker-test",
        limit: 50,
        now: new Date(),
        handlers: defaultJobHandlers,
      });
      const { getReadyDb } = await import("@syntholo/db");
      const db = await getReadyDb();
      const [row] = await db`SELECT published_at FROM outbox_events WHERE id = ${id}`;
      publishedAt = row?.published_at ? new Date(row.published_at as string | Date) : null;
    }

    expect(publishedAt).toBeInstanceOf(Date);
    const { getReadyDb } = await import("@syntholo/db");
    const db = await getReadyDb();
    const receipts = await db`
      SELECT handler_name FROM handler_receipts
      WHERE handler_name = ${"outbox.publish"} AND event_id = ${id}
    `;
    expect(receipts).toHaveLength(1);
  });

  it("exposes /jobs/tick without account identifiers", async () => {
    const app = buildWorker();
    const response = await app.inject({ method: "POST", url: "/jobs/tick" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("accountId");
    expect(typeof body.claimed).toBe("number");
    expect(typeof body.completed).toBe("number");
    expect(typeof body.failed).toBe("number");
    await app.close();
  });

  it("records a handler SQL failure on the job instead of aborting failJob", async () => {
    const { enqueueJob, withSystemScope } = await import("@syntholo/db");
    const kind = `sql-fail-${Date.now()}`;
    const job = await withSystemScope((db) =>
      enqueueJob(db, {
        kind,
        payload: {},
        maxAttempts: 1,
        priority: 1_000,
      }),
    );

    const result = await processJobBatch({
      workerId: "worker-sql-fail",
      limit: 1,
      now: new Date(),
      handlers: {
        [kind]: async (_job, db) => {
          await db`
            INSERT INTO handler_receipts (handler_name, event_id)
            VALUES (${"sql-fail"}, ${"00000000-0000-0000-0000-000000000000"})
          `;
        },
      },
    });
    expect(result.claimed).toBe(1);
    expect(result.failed).toBe(1);

    const { getReadyDb } = await import("@syntholo/db");
    const db = await getReadyDb();
    const [row] = await db`SELECT status, attempt, last_error_code FROM jobs WHERE id = ${job.id}`;
    expect(row.status).toBe("dead_letter");
    expect(Number(row.attempt)).toBe(1);
    expect(row.last_error_code).toBeTruthy();
  });
});
