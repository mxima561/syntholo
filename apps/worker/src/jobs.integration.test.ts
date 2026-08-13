import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  JobRepository,
  nextAttempt,
  OutboxProcessorRepository,
  HandlerReceiptRepository,
  type ClaimedJob,
} from "@syntholo/database";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "@syntholo/testing";

const now = new Date("2026-08-13T16:00:00.000Z");

function job(index: number, patch: Record<string, unknown> = {}) {
  return {
    correlationId: "10000000-0000-4000-8000-000000000090",
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    idempotencyKey: `test:job:${index}`,
    payload: { referenceId: `aggregate_${index}` },
    runAt: now,
    type: "foundation.test_job.v1",
    sourceActorId: "foundation_test",
    sourceActorType: "system" as const,
    ...patch,
  };
}

describe("durable job repository", () => {
  let harness: TestDatabaseHarness;
  let jobs: JobRepository;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    jobs = new JobRepository(harness.database, { leaseMs: 10_000 });
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("claims each due job exactly once across two workers", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, index) => jobs.enqueue(job(index + 1))));

    const [left, right] = await Promise.all([
      jobs.claim(10, "worker-a", now),
      jobs.claim(10, "worker-b", now),
    ]);
    const claimed = [...left, ...right];

    expect(claimed).toHaveLength(10);
    expect(new Set(claimed.map(({ id }) => id)).size).toBe(10);
    expect(claimed.every(({ attempt, claimGeneration, claimToken }) =>
      attempt === 1 && claimGeneration === 1 && /^[0-9a-f-]{36}$/u.test(claimToken)
    )).toBe(true);
    const attempts = await harness.database.pool.query(
      "select job_id, attempt, outcome from job_attempts order by job_id",
    );
    expect(attempts.rows).toHaveLength(10);
    expect(attempts.rows.every(({ attempt, outcome }) =>
      attempt === 1 && outcome === "running"
    )).toBe(true);
  });

  it("claims exactly once across eight workers with deterministic bounded batches", async () => {
    await Promise.all(Array.from({ length: 32 }, (_, index) =>
      jobs.enqueue(job(index + 1, { priority: index % 3 }))
    ));

    const batches = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      jobs.claim(4, `worker-${index}`, now)
    ));
    const ids = batches.flatMap((batch) => batch.map(({ id }) => id));

    expect(batches.every((batch) => batch.length <= 4)).toBe(true);
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
  });

  it("orders by priority descending, run time, and id while excluding future work", async () => {
    await jobs.enqueue(job(3, { priority: 2 }));
    await jobs.enqueue(job(2, { priority: 2 }));
    await jobs.enqueue(job(1, { priority: 1 }));
    await jobs.enqueue(job(4, {
      priority: 20,
      runAt: new Date(now.getTime() + 1),
    }));

    const claimed = await jobs.claim(3, "worker-order", now);

    expect(claimed.map(({ id }) => id)).toEqual([
      job(2).id,
      job(3).id,
      job(1).id,
    ]);
  });

  it.each([0, -1, 1.5, 101])("rejects claim limit %s before SQL", async (limit) => {
    const query = harness.database.pool.query.bind(harness.database.pool);
    let queryCalls = 0;
    harness.database.pool.query = ((...args: Parameters<typeof query>) => {
      queryCalls += 1;
      return query(...args);
    }) as typeof harness.database.pool.query;
    try {
      await expect(jobs.claim(limit, "worker-limit", now)).rejects.toThrow(
        "JOB_CLAIM_INPUT_INVALID",
      );
      expect(queryCalls).toBe(0);
    } finally {
      harness.database.pool.query = query;
    }
  });

  it("rolls back the claim when attempt insertion fails", async () => {
    await jobs.enqueue(job(1));
    await harness.database.pool.query(`
      create function task7_reject_attempt() returns trigger language plpgsql as $$
      begin raise exception 'EXPECTED_ATTEMPT_REJECTION'; end $$;
      create trigger task7_reject_attempt before insert on job_attempts
      for each row execute function task7_reject_attempt();
    `);
    try {
      await expect(jobs.claim(1, "worker-atomic", now)).rejects.toThrow();
      const persisted = await harness.database.pool.query(
        "select status, attempts, claim_token from jobs",
      );
      expect(persisted.rows).toEqual([{
        attempts: 0,
        claim_token: null,
        status: "queued",
      }]);
    } finally {
      await harness.database.pool.query(
        "drop trigger task7_reject_attempt on job_attempts; drop function task7_reject_attempt()",
      );
    }
  });

  it("does not reclaim an unexpired lease and reclaims at the expiry boundary", async () => {
    await jobs.enqueue(job(1));
    const first = (await jobs.claim(1, "worker-first", now))[0]!;

    await expect(jobs.claim(
      1,
      "worker-second",
      new Date(now.getTime() + 9_999),
    )).resolves.toEqual([]);
    const reclaimed = await jobs.claim(
      1,
      "worker-second",
      new Date(now.getTime() + 10_000),
    );

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ attempt: 2, claimGeneration: 2 });
    expect(reclaimed[0]?.claimToken).not.toBe(first.claimToken);
  });

  it("denies stale completion and failure after reclaim", async () => {
    await jobs.enqueue(job(1));
    const stale = (await jobs.claim(1, "worker-first", now))[0]!;
    const reclaimedAt = new Date(now.getTime() + 10_000);
    const current = (await jobs.claim(1, "worker-second", reclaimedAt))[0]!;

    await expect(jobs.complete(stale, reclaimedAt)).resolves.toEqual({
      kind: "stale_claim",
    });
    await expect(jobs.fail(
      stale,
      { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false },
      reclaimedAt,
      0,
    )).resolves.toEqual({ kind: "stale_claim" });
    await expect(jobs.complete(
      current,
      new Date(reclaimedAt.getTime() + 1),
    )).resolves.toEqual({ kind: "completed" });
  });

  it("extends a live job lease with the exact fence and prevents boundary reclaim", async () => {
    await jobs.enqueue(job(1));
    const claim = (await jobs.claim(1, "worker-heartbeat", now))[0]!;
    const heartbeatAt = new Date(now.getTime() + 5_000);
    await expect(jobs.extendLease(claim, heartbeatAt)).resolves.toEqual({
      kind: "extended",
      leaseExpiresAt: new Date(now.getTime() + 15_000),
    });
    await expect(jobs.claim(1, "worker-second", new Date(now.getTime() + 10_000)))
      .resolves.toEqual([]);
    await expect(jobs.extendLease(
      { ...claim, claimToken: randomUUID() },
      new Date(now.getTime() + 10_001),
    )).resolves.toEqual({ kind: "stale_claim" });
    const reclaimed = await jobs.claim(
      1,
      "worker-second",
      new Date(now.getTime() + 15_000),
    );
    expect(reclaimed[0]).toMatchObject({ attempt: 2, workerId: "worker-second" });
  });

  it("denies completion and failure at the exact lease boundary before reclaim", async () => {
    await jobs.enqueue(job(1));
    const claim = (await jobs.claim(1, "worker-expired", now))[0]!;
    const expiredAt = new Date(now.getTime() + 10_000);

    await expect(jobs.complete(claim, expiredAt)).resolves.toEqual({
      kind: "stale_claim",
    });
    await expect(jobs.fail(
      claim,
      { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false },
      expiredAt,
      0,
    )).resolves.toEqual({ kind: "stale_claim" });
  });

  it("dead-letters a crashed final attempt at lease expiry without aborting sibling claims", async () => {
    await jobs.enqueue(job(1, { maxAttempts: 1, priority: 10 }));
    await jobs.enqueue(job(2, { priority: 1 }));
    await jobs.claim(1, "worker-crashed", now);

    const claimed = await jobs.claim(
      2,
      "worker-recovery",
      new Date(now.getTime() + 10_000),
    );
    expect(claimed.map(({ id }) => id)).toEqual([job(2).id]);
    const persisted = await harness.database.pool.query(
      "select id, status, attempts, last_error_code from jobs order by id",
    );
    expect(persisted.rows).toEqual([
      {
        attempts: 1,
        id: job(1).id,
        last_error_code: "JOB_LEASE_EXPIRED",
        status: "dead_letter",
      },
      {
        attempts: 1,
        id: job(2).id,
        last_error_code: null,
        status: "running",
      },
    ]);
    const later = await jobs.claim(
      2,
      "worker-later",
      new Date(now.getTime() + 20_000),
    );
    expect(later.every(({ id }) => id !== job(1).id)).toBe(true);
    const history = await harness.database.pool.query(
      "select outcome, finished_at >= started_at as monotonic from job_attempts where job_id = $1",
      [job(1).id],
    );
    expect(history.rows).toEqual([{ monotonic: true, outcome: "lease_expired" }]);
  });

  it("dead-letters a poison payload independently and returns healthy claimed siblings", async () => {
    await harness.database.pool.query(
      `insert into jobs
       (id, idempotency_key, source_actor_type, source_actor_id, correlation_id,
        type, payload, run_at, priority)
       values ($1, 'poison:job:1', 'system', 'foundation_test', $2,
        'foundation.test_job.v1', '{"body":"opaque"}', $3, 20)`,
      [job(1).id, job(1).correlationId, now],
    );
    await jobs.enqueue(job(2, { priority: 10 }));

    const claimed = await jobs.claim(2, "worker-poison", now);
    expect(claimed.map(({ id }) => id)).toEqual([job(2).id]);
    const poison = await harness.database.pool.query(
      "select status, last_error_code, last_error_message, payload from jobs where id = $1",
      [job(1).id],
    );
    expect(poison.rows).toEqual([{
      last_error_code: "JOB_INPUT_INVALID",
      last_error_message: "Job input invalid",
      payload: {},
      status: "dead_letter",
    }]);
    expect(JSON.stringify(poison.rows)).not.toContain("opaque");
  });

  it("rejects null and unsafe direct transition inputs at the database boundary", async () => {
    await jobs.enqueue(job(1));
    const claim = (await jobs.claim(1, "worker-direct", now))[0]!;

    await expect(harness.database.pool.query(
      "select public.syntholo_claim_jobs(null, 'worker-direct', $1, 1000)",
      [now],
    )).rejects.toThrow("SYNTHOLO_JOB_CLAIM_INPUT_INVALID");
    await expect(harness.database.pool.query(
      "select public.syntholo_fail_job($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        claim.id,
        claim.workerId,
        claim.attempt,
        claim.claimGeneration,
        claim.claimToken,
        now,
        "JOB_HANDLER_FAILED",
        "unsafe secret detail",
        new Date(now.getTime() - 1),
      ],
    )).rejects.toThrow("SYNTHOLO_JOB_TRANSITION_INPUT_INVALID");
    await expect(jobs.complete(claim, now)).resolves.toEqual({ kind: "completed" });
  });

  it("retries transient failure deterministically and dead-letters exhaustion", async () => {
    await jobs.enqueue(job(1, { maxAttempts: 2 }));
    const first = (await jobs.claim(1, "worker-retry", now))[0]!;
    const firstFailure = await jobs.fail(
      first,
      { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false },
      now,
      0.5,
    );
    expect(firstFailure).toEqual({
      kind: "retry_scheduled",
      runAt: new Date(now.getTime() + 1_125),
    });

    const retryAt = new Date(now.getTime() + 1_125);
    const second = (await jobs.claim(1, "worker-retry", retryAt))[0]!;
    await expect(jobs.fail(
      second,
      { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false },
      retryAt,
      0,
    )).resolves.toEqual({ kind: "dead_lettered" });
    const persisted = await harness.database.pool.query(
      "select status, attempts, last_error_code, last_error_message from jobs",
    );
    expect(persisted.rows).toEqual([{
      attempts: 2,
      last_error_code: "JOB_DEPENDENCY_UNAVAILABLE",
      last_error_message: "Job dependency unavailable",
      status: "dead_letter",
    }]);
    const history = await harness.database.pool.query(
      "select attempt, outcome from job_attempts order by attempt",
    );
    expect(history.rows).toEqual([
      { attempt: 1, outcome: "retry" },
      { attempt: 2, outcome: "dead_letter" },
    ]);
  });

  it("dead-letters a permanent failure immediately with safe fixed errors", async () => {
    await jobs.enqueue(job(1, { maxAttempts: 5 }));
    const claim = (await jobs.claim(1, "worker-permanent", now))[0]!;
    const unsafe = new Error("unpersisted exception detail");

    await expect(jobs.fail(
      claim,
      { cause: unsafe, code: "JOB_INPUT_INVALID", permanent: true },
      now,
      0,
    )).resolves.toEqual({ kind: "dead_lettered" });
    const persisted = await harness.database.pool.query(
      "select last_error_code, last_error_message from jobs",
    );
    expect(persisted.rows).toEqual([{
      last_error_code: "JOB_INPUT_INVALID",
      last_error_message: "Job input invalid",
    }]);
    expect(JSON.stringify(persisted.rows)).not.toContain(unsafe.message);
  });

  it("computes bounded deterministic exponential backoff with jitter", () => {
    expect(nextAttempt(1, now, 0)).toEqual(new Date(now.getTime() + 1_000));
    expect(nextAttempt(1, now, 0.999)).toEqual(new Date(now.getTime() + 1_249));
    expect(nextAttempt(20, now, 0.999)).toEqual(
      new Date(now.getTime() + 3_600_000),
    );
    expect(() => nextAttempt(1, now, 1)).toThrow("JOB_RETRY_INPUT_INVALID");
  });

  it("converges exact enqueue-once calls and rejects a conflicting idempotency key", async () => {
    const exact = await Promise.all(Array.from({ length: 8 }, () => jobs.enqueueOnce(job(1))));
    expect(new Set(exact.map(({ id }) => id))).toEqual(new Set([job(1).id]));

    await expect(jobs.enqueueOnce(job(2, {
      idempotencyKey: job(1).idempotencyKey,
    }))).rejects.toThrow("JOB_IDEMPOTENCY_CONFLICT");
    const count = await harness.database.pool.query<{ count: string }>(
      "select count(*)::text as count from jobs",
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it.each([
    "contains spaces",
    "authorization:opaque",
    ["sk_", "live_", "opaque"].join(""),
    "line\u0000break",
  ])("rejects unsafe idempotency metadata before SQL", async (idempotencyKey) => {
    await expect(jobs.enqueue(job(1, { idempotencyKey }))).rejects.toThrow(
      "JOB_INPUT_INVALID",
    );
  });

  it("returns a typed stale result for a fabricated fence", async () => {
    await jobs.enqueue(job(1));
    const claim = (await jobs.claim(1, "worker-fence", now))[0]!;
    const fabricated: ClaimedJob = { ...claim, claimToken: randomUUID() };
    await expect(jobs.complete(fabricated, now)).resolves.toEqual({
      kind: "stale_claim",
    });
  });
});

describe("durable outbox dispatch and handler receipts", () => {
  let harness: TestDatabaseHarness;
  let jobs: JobRepository;
  let outbox: OutboxProcessorRepository;
  let receipts: HandlerReceiptRepository;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
    jobs = new JobRepository(harness.database, { leaseMs: 10_000 });
    outbox = new OutboxProcessorRepository(harness.database, { leaseMs: 10_000 });
    receipts = new HandlerReceiptRepository(harness.database, { leaseMs: 10_000 });
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness?.close();
  });

  async function seedEvent(eventId = "20000000-0000-4000-8000-000000000001") {
    await harness.database.pool.query(
      `insert into outbox_events
       (event_id, actor_type, actor_id, correlation_id, type, aggregate_id,
        occurred_at, payload, available_at)
       values ($1, 'system', 'foundation_test', $2,
         'foundation.notification_sent.v1', 'aggregate_1', $3,
         '{"referenceId":"aggregate_1"}', $3)`,
      [eventId, "20000000-0000-4000-8000-000000000002", now],
    );
    return eventId;
  }

  async function seedEventAt(eventId: string, availableAt: Date, attempts = 0, maxAttempts = 10) {
    await harness.database.pool.query(
      `insert into outbox_events
       (event_id, actor_type, actor_id, correlation_id, type, aggregate_id,
        occurred_at, payload, available_at, attempts, max_attempts)
       values ($1,'system','foundation_test',$2,'foundation.notification_sent.v1',
         'aggregate_1',$3,'{"referenceId":"aggregate_1"}',$3,$4,$5)`,
      [eventId, "20000000-0000-4000-8000-000000000002", availableAt,
        attempts, maxAttempts],
    );
  }

  async function claimHandlerJob(
    eventId: string,
    handlerName: string,
    workerId: string,
    at = now,
  ): Promise<ClaimedJob> {
    const eventClaims = await outbox.claim(1, `${workerId}-outbox`, at);
    if (eventClaims.length > 0) {
      const dispatched = await outbox.dispatch(eventClaims[0]!, [handlerName], at);
      if (dispatched.kind !== "published") throw new Error("EXPECTED_DISPATCH");
    }
    const claimed = await jobs.claim(1, workerId, at);
    if (!claimed[0]) throw new Error("EXPECTED_JOB");
    return claimed[0];
  }

  it("claims one outbox event once across eight workers and dispatches handler jobs atomically", async () => {
    const eventId = await seedEvent();
    const batches = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      outbox.claim(1, `outbox-${index}`, now)
    ));
    const claims = batches.flat();
    expect(claims).toHaveLength(1);

    await expect(outbox.dispatch(
      claims[0]!,
      ["search_index", "webhook_delivery"],
      now,
    )).resolves.toEqual({ kind: "published", jobsCreated: 2 });
    const persisted = await harness.database.pool.query(
      `select o.status, j.idempotency_key, j.correlation_id,
              j.source_actor_type, j.source_actor_id, j.payload
       from outbox_events o join jobs j on true
       where o.event_id = $1 order by j.idempotency_key`,
      [eventId],
    );
    expect(persisted.rows).toEqual([
      {
        correlation_id: "20000000-0000-4000-8000-000000000002",
        idempotency_key: `event:search_index:${eventId}`,
        payload: { eventId, handlerName: "search_index" },
        source_actor_id: "foundation_test",
        source_actor_type: "system",
        status: "published",
      },
      {
        correlation_id: "20000000-0000-4000-8000-000000000002",
        idempotency_key: `event:webhook_delivery:${eventId}`,
        payload: { eventId, handlerName: "webhook_delivery" },
        source_actor_id: "foundation_test",
        source_actor_type: "system",
        status: "published",
      },
    ]);
  });

  it("reclaims an expired outbox lease and fences the stale publisher", async () => {
    await seedEvent();
    const stale = (await outbox.claim(1, "outbox-stale", now))[0]!;
    const boundary = new Date(now.getTime() + 10_000);
    await expect(outbox.dispatch(stale, ["search_index"], boundary)).resolves.toEqual({
      kind: "stale_claim",
    });
    const current = (await outbox.claim(1, "outbox-current", boundary))[0]!;
    expect(current.attempt).toBe(2);
    await expect(outbox.dispatch(current, ["search_index"], boundary)).resolves.toEqual({
      kind: "published",
      jobsCreated: 1,
    });
  });

  it("claims outbox rows deterministically and excludes future events", async () => {
    await seedEventAt("20000000-0000-4000-8000-000000000003", now);
    await seedEventAt("20000000-0000-4000-8000-000000000002", now);
    await seedEventAt("20000000-0000-4000-8000-000000000004", new Date(now.getTime() + 1));
    const claimed = await outbox.claim(2, "outbox-order", now);
    expect(claimed.map(({ eventId }) => eventId)).toEqual([
      "20000000-0000-4000-8000-000000000003",
      "20000000-0000-4000-8000-000000000002",
    ]);
  });

  it("schedules bounded jitter and dead-letters a final outbox attempt", async () => {
    await seedEventAt("20000000-0000-4000-8000-000000000005", now, 0, 2);
    const first = (await outbox.claim(1, "outbox-retry", now))[0]!;
    await expect(outbox.fail(first, now, { permanent: false }, 0.999))
      .resolves.toEqual({
        kind: "retry_scheduled",
        runAt: new Date(now.getTime() + 1_249),
      });
    const retryAt = new Date(now.getTime() + 1_249);
    const final = (await outbox.claim(1, "outbox-retry", retryAt))[0]!;
    await expect(outbox.fail(final, retryAt, { permanent: false }, 0))
      .resolves.toEqual({ kind: "dead_lettered" });
    const persisted = await harness.database.pool.query(
      "select status, dead_lettered_at, last_error_code, last_error_message from outbox_events",
    );
    expect(persisted.rows).toEqual([{
      dead_lettered_at: retryAt,
      last_error_code: "OUTBOX_DISPATCH_FAILED",
      last_error_message: "Outbox dispatch failed",
      status: "dead_letter",
    }]);
  });

  it("rolls back all handler jobs and publish when a dispatch job conflicts", async () => {
    const eventId = await seedEvent();
    const claim = (await outbox.claim(1, "outbox-atomic", now))[0]!;
    await harness.database.pool.query(
      `insert into jobs
       (id, source_actor_type, source_actor_id, correlation_id, queue, type,
        idempotency_key, payload, run_at)
       values ($1,'system','different',$2,'events','foundation.domain_event_handler.v1',
         $3,'{"eventId":"20000000-0000-4000-8000-000000000001","handlerName":"second"}',$4)`,
      [
        "20000000-0000-4000-8000-000000000009",
        "20000000-0000-4000-8000-000000000002",
        `event:second:${eventId}`,
        now,
      ],
    );
    await expect(outbox.dispatch(claim, ["first", "second"], now)).rejects.toThrow();
    const persisted = await harness.database.pool.query(
      `select o.status, count(j.id)::int as jobs
       from outbox_events o left join jobs j on j.idempotency_key like 'event:%'
       where o.event_id=$1 group by o.status`,
      [eventId],
    );
    expect(persisted.rows).toEqual([{ jobs: 1, status: "processing" }]);
    expect((await harness.database.pool.query(
      "select count(*)::int as count from jobs where idempotency_key=$1",
      [`event:first:${eventId}`],
    )).rows[0]?.count).toBe(0);
  });

  it("converges receipt races, skips completed replay, and recovers a crashed lease", async () => {
    const eventId = await seedEvent();
    const firstJob = await claimHandlerJob(eventId, "search_index", "handler-first");
    const raced = await Promise.all(Array.from({ length: 8 }, () =>
      receipts.acquire(firstJob, now)
    ));
    const acquired = raced.filter((result) => result.kind === "acquired");
    expect(acquired).toHaveLength(1);
    const first = acquired[0]!;
    if (first.kind !== "acquired") throw new Error("EXPECTED_RECEIPT");
    await expect(receipts.acquire(firstJob, new Date(now.getTime() + 9_999)))
      .resolves.toEqual({
        kind: "busy",
        leaseExpiresAt: new Date(now.getTime() + 10_000),
      });
    const boundary = new Date(now.getTime() + 10_000);
    const recoveredJob = (await jobs.claim(1, "handler-recovered", boundary))[0]!;
    const recovered = await receipts.acquire(recoveredJob, boundary);
    expect(recovered).toMatchObject({ kind: "acquired", attempt: 2 });
    if (recovered.kind !== "acquired") throw new Error("EXPECTED_RECEIPT");
    await expect(receipts.complete(recovered, new Date(now.getTime() + 10_001)))
      .resolves.toEqual({ kind: "completed" });
    await expect(receipts.complete(first, new Date(now.getTime() + 10_001)))
      .resolves.toEqual({ kind: "stale_claim" });
    await expect(receipts.acquire(recoveredJob, new Date(now.getTime() + 10_002)))
      .resolves.toEqual({ kind: "completed" });
  });

  it("atomically completes the receipt with a provenance-linked worker audit fact", async () => {
    const eventId = await seedEvent();
    const handlerJob = await claimHandlerJob(eventId, "search_index", "handler-local");
    const claim = await receipts.acquire(handlerJob, now);
    if (claim.kind !== "acquired") throw new Error("EXPECTED_RECEIPT");

    await expect(receipts.complete(claim, new Date(now.getTime() + 1)))
      .resolves.toEqual({ kind: "completed" });
    const persisted = await harness.database.pool.query(
      `select r.status, a.account_id, a.actor_type, a.actor_id, a.correlation_id,
              a.action, a.target_id, a.payload
       from event_handler_receipts r
       join audit_events a on a.target_id = r.event_id::text`,
    );
    expect(persisted.rows).toEqual([{
      account_id: null,
      action: "handler_delivery_completed",
      actor_id: "handler-local",
      actor_type: "system",
      correlation_id: "20000000-0000-4000-8000-000000000002",
      payload: { eventId, handlerName: "search_index", outcome: "completed" },
      status: "completed",
      target_id: eventId,
    }]);
  });

  it("rolls receipt completion back when the atomic worker-audit effect fails", async () => {
    const eventId = await seedEvent();
    const handlerJob = await claimHandlerJob(eventId, "search_index", "handler-rollback");
    const claim = await receipts.acquire(handlerJob, now);
    if (claim.kind !== "acquired") throw new Error("EXPECTED_RECEIPT");
    await harness.database.pool.query(`
      create function task7_reject_worker_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'handler_delivery_completed' then
          raise exception 'EXPECTED_WORKER_AUDIT_REJECTION';
        end if;
        return new;
      end $$;
      create trigger task7_reject_worker_audit before insert on audit_events
      for each row execute function task7_reject_worker_audit()
    `);
    try {
      await expect(receipts.complete(claim, new Date(now.getTime() + 1))).rejects.toThrow();
      const unchanged = await harness.database.pool.query(
        "select status, completed_at from event_handler_receipts",
      );
      expect(unchanged.rows).toEqual([{ completed_at: null, status: "processing" }]);
      expect((await harness.database.pool.query(
        "select count(*)::int as count from audit_events where action = 'handler_delivery_completed'",
      )).rows[0]?.count).toBe(0);
    } finally {
      await harness.database.pool.query(
        "drop trigger task7_reject_worker_audit on audit_events; drop function task7_reject_worker_audit()",
      );
    }
    await expect(receipts.complete(claim, new Date(now.getTime() + 2)))
      .resolves.toEqual({ kind: "completed" });
  });

  it("abandons a transient receipt so the scheduled job retry can reacquire it", async () => {
    const eventId = await seedEvent();
    const firstJob = await claimHandlerJob(eventId, "search_index", "handler-retry");
    const firstReceipt = await receipts.acquire(firstJob, now);
    if (firstReceipt.kind !== "acquired") throw new Error("EXPECTED_RECEIPT");
    const failedAt = new Date(now.getTime() + 1);
    await expect(receipts.abandon(firstReceipt, failedAt)).resolves.toEqual({ kind: "abandoned" });
    const failed = await jobs.fail(
      firstJob,
      { code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false },
      failedAt,
      0,
    );
    if (failed.kind !== "retry_scheduled") throw new Error("EXPECTED_RETRY");
    const retryJob = (await jobs.claim(1, "handler-retry", failed.runAt))[0]!;
    const retryReceipt = await receipts.acquire(retryJob, failed.runAt);
    expect(retryReceipt).toMatchObject({ kind: "acquired", attempt: 2 });
    if (retryReceipt.kind !== "acquired") throw new Error("EXPECTED_RECEIPT");
    await expect(receipts.complete(retryReceipt, new Date(failed.runAt.getTime() + 1)))
      .resolves.toEqual({ kind: "completed" });
  });
});
