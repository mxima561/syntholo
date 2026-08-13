import { isDeepStrictEqual } from "node:util";
import { Buffer } from "node:buffer";
import type { JsonObject } from "@syntholo/domain";
import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { assertSafeOperationalPayload } from "../payload-policy.js";
import { jobs } from "../schema/index.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const workerPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_CLAIM_BATCH = 100;
const MAX_BACKOFF_MS = 3_600_000;

export type JobInput = Readonly<{
  accountId?: string | null;
  correlationId: string;
  id: string;
  idempotencyKey: string;
  maxAttempts?: number;
  payload: JsonObject;
  priority?: number;
  queue?: string;
  runAt: Date;
  type: string;
  sourceActorId: string;
  sourceActorType: "member" | "staff" | "system";
}>;

export type ClaimedJob = Readonly<{
  accountId: string | null;
  correlationId: string;
  attempt: number;
  claimGeneration: number;
  claimToken: string;
  id: string;
  idempotencyKey: string;
  leaseExpiresAt: Date;
  maxAttempts: number;
  payload: JsonObject;
  type: string;
  sourceActorId: string;
  sourceActorType: "member" | "staff" | "system";
  workerId: string;
}>;

export type JobErrorCode =
  | "JOB_DEPENDENCY_UNAVAILABLE"
  | "JOB_HANDLER_FAILED"
  | "JOB_INPUT_INVALID";

export type ClassifiedJobFailure = Readonly<{
  cause?: unknown;
  code: JobErrorCode;
  permanent: boolean;
  retryAt?: Date;
}>;

export type JobTransitionResult =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "dead_lettered" }>
  | Readonly<{ kind: "retry_scheduled"; runAt: Date }>
  | Readonly<{ kind: "stale_claim" }>;

export type LeaseExtensionResult =
  | Readonly<{ kind: "extended"; leaseExpiresAt: Date }>
  | Readonly<{ kind: "stale_claim" }>;

const safeErrorMessages: Readonly<Record<JobErrorCode, string>> = Object.freeze({
  JOB_DEPENDENCY_UNAVAILABLE: "Job dependency unavailable",
  JOB_HANDLER_FAILED: "Job handler failed",
  JOB_INPUT_INVALID: "Job input invalid",
});

function assertJobInput(input: JobInput): void {
  try {
    if (
      !canonicalUuidPattern.test(input.id)
    || (input.accountId !== undefined
      && input.accountId !== null
      && !canonicalUuidPattern.test(input.accountId))
    || input.idempotencyKey.length < 1
    || Buffer.byteLength(input.idempotencyKey, "utf8") > 512
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input.idempotencyKey)
    || /(?:authorization|credential|password|secret|token|sk_(?:live|test))/iu
      .test(input.idempotencyKey)
    || !identifierPattern.test(input.type)
    || !canonicalUuidPattern.test(input.correlationId)
    || !identifierPattern.test(input.sourceActorId)
    || !["member", "staff", "system"].includes(input.sourceActorType)
    || !workerPattern.test(input.queue ?? "default")
    || !Number.isFinite(input.runAt.getTime())
    || !Number.isInteger(input.priority ?? 0)
    || (input.priority ?? 0) < -1000
    || (input.priority ?? 0) > 1000
    || !Number.isInteger(input.maxAttempts ?? 5)
    || (input.maxAttempts ?? 5) < 1
    || (input.maxAttempts ?? 5) > 100
    ) {
      throw new Error("invalid");
    }
    assertSafeOperationalPayload(input.payload);
  } catch {
    throw new Error("JOB_INPUT_INVALID");
  }
}

function assertClaimInput(limit: number, workerId: string, now: Date): void {
  if (
    !Number.isInteger(limit)
    || limit < 1
    || limit > MAX_CLAIM_BATCH
    || !workerPattern.test(workerId)
    || !Number.isFinite(now.getTime())
  ) {
    throw new Error("JOB_CLAIM_INPUT_INVALID");
  }
}

function postgresCode(error: unknown): string | undefined {
  let current = error;
  while (current instanceof Error) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

export function nextAttempt(attempt: number, now: Date, random: number): Date {
  if (
    !Number.isInteger(attempt)
    || attempt < 1
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(random)
    || random < 0
    || random >= 1
  ) {
    throw new Error("JOB_RETRY_INPUT_INVALID");
  }
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (attempt - 1));
  const jitter = Math.floor(base * 0.25 * random);
  const result = new Date(now.getTime() + Math.min(MAX_BACKOFF_MS, base + jitter));
  if (!Number.isFinite(result.getTime())) throw new Error("JOB_RETRY_INPUT_INVALID");
  return result;
}

type ClaimedJobRow = {
  account_id: string | null;
  correlation_id: string;
  attempts: number;
  claim_generation: number;
  claim_token: string;
  id: string;
  idempotency_key: string;
  lease_expires_at: Date;
  max_attempts: number;
  payload: JsonObject;
  type: string;
  source_actor_id: string;
  source_actor_type: "member" | "staff" | "system";
  worker_id: string;
};

export class JobRepository {
  private readonly leaseMs: number;
  readonly heartbeatIntervalMs: number;

  constructor(
    private readonly database: Database,
    options: Readonly<{ leaseMs: number }>,
  ) {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs < 3 || options.leaseMs > 3_600_000) {
      throw new Error("JOB_REPOSITORY_CONFIG_INVALID");
    }
    this.leaseMs = options.leaseMs;
    this.heartbeatIntervalMs = Math.max(1, Math.floor(options.leaseMs / 3));
  }

  async enqueue(input: JobInput): Promise<Readonly<{ id: string }>> {
    assertJobInput(input);
    const payload = assertSafeOperationalPayload(input.payload);
    try {
      await this.database.insert(jobs).values({
        accountId: input.accountId ?? null,
        correlationId: input.correlationId,
        id: input.id,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? 5,
        payload,
        priority: input.priority ?? 0,
        queue: input.queue ?? "default",
        runAt: input.runAt,
        type: input.type,
        sourceActorId: input.sourceActorId,
        sourceActorType: input.sourceActorType,
      });
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw new Error("JOB_IDEMPOTENCY_CONFLICT");
      }
      throw error;
    }
    return { id: input.id };
  }

  async enqueueOnce(input: JobInput): Promise<Readonly<{ id: string }>> {
    assertJobInput(input);
    const payload = assertSafeOperationalPayload(input.payload);
    const inserted = await this.database.insert(jobs).values({
      accountId: input.accountId ?? null,
      correlationId: input.correlationId,
      id: input.id,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts ?? 5,
      payload,
      priority: input.priority ?? 0,
      queue: input.queue ?? "default",
      runAt: input.runAt,
      type: input.type,
      sourceActorId: input.sourceActorId,
      sourceActorType: input.sourceActorType,
    }).onConflictDoNothing().returning({ id: jobs.id });
    if (inserted[0]) return inserted[0];
    const existing = await this.database.select().from(jobs).where(
      eq(jobs.idempotencyKey, input.idempotencyKey),
    ).limit(1);
    const row = existing[0];
    if (
      row === undefined
      || row.id !== input.id
      || row.accountId !== (input.accountId ?? null)
      || row.correlationId !== input.correlationId
      || row.type !== input.type
      || row.sourceActorId !== input.sourceActorId
      || row.sourceActorType !== input.sourceActorType
      || row.queue !== (input.queue ?? "default")
      || row.priority !== (input.priority ?? 0)
      || row.maxAttempts !== (input.maxAttempts ?? 5)
      || row.runAt.getTime() !== input.runAt.getTime()
      || !isDeepStrictEqual(row.payload, payload)
    ) {
      throw new Error("JOB_IDEMPOTENCY_CONFLICT");
    }
    return { id: row.id };
  }

  async claim(limit: number, workerId: string, now: Date): Promise<readonly ClaimedJob[]> {
    assertClaimInput(limit, workerId, now);
    const result = await this.database.pool.query<ClaimedJobRow>(
      "select * from public.syntholo_claim_jobs($1, $2, $3, $4)",
      [limit, workerId, now, this.leaseMs],
    );
    const claimed: ClaimedJob[] = [];
    for (const row of result.rows) {
      const fence = Object.freeze({
        accountId: row.account_id,
        correlationId: row.correlation_id,
        attempt: row.attempts,
        claimGeneration: row.claim_generation,
        claimToken: row.claim_token,
        id: row.id,
        idempotencyKey: row.idempotency_key,
        leaseExpiresAt: row.lease_expires_at,
        maxAttempts: row.max_attempts,
        payload: Object.freeze({}) as JsonObject,
        type: row.type,
        sourceActorId: row.source_actor_id,
        sourceActorType: row.source_actor_type,
        workerId: row.worker_id,
      });
      try {
        claimed.push(Object.freeze({
          ...fence,
          payload: assertSafeOperationalPayload(row.payload),
        }));
      } catch {
        const quarantined = await this.database.pool.query<{ quarantined: boolean }>(
          "select public.syntholo_quarantine_job_payload($1,$2,$3,$4,$5,$6) as quarantined",
          [fence.id, fence.workerId, fence.attempt, fence.claimGeneration, fence.claimToken, now],
        );
        if (!quarantined.rows[0]?.quarantined) {
          throw new Error("JOB_TRANSITION_FAILED");
        }
      }
    }
    return claimed;
  }

  async complete(claim: ClaimedJob, now: Date): Promise<JobTransitionResult> {
    assertLiveFence(claim, now);
    const result = await this.database.pool.query<{ transitioned: boolean }>(
      "select public.syntholo_complete_job($1,$2,$3,$4,$5,$6) as transitioned",
      [claim.id, claim.workerId, claim.attempt, claim.claimGeneration, claim.claimToken, now],
    );
    return result.rows[0]?.transitioned
      ? { kind: "completed" }
      : { kind: "stale_claim" };
  }

  async extendLease(claim: ClaimedJob, now: Date): Promise<LeaseExtensionResult> {
    assertLiveFence(claim, now);
    const result = await this.database.pool.query<{ lease_expires_at: Date | null }>(
      "select public.syntholo_extend_job_lease($1,$2,$3,$4,$5,$6,$7) as lease_expires_at",
      [claim.id, claim.workerId, claim.attempt, claim.claimGeneration,
        claim.claimToken, now, this.leaseMs],
    );
    const leaseExpiresAt = result.rows[0]?.lease_expires_at;
    return leaseExpiresAt instanceof Date
      ? { kind: "extended", leaseExpiresAt }
      : { kind: "stale_claim" };
  }

  async fail(
    claim: ClaimedJob,
    failure: ClassifiedJobFailure,
    now: Date,
    random: number,
  ): Promise<JobTransitionResult> {
    assertLiveFence(claim, now);
    const message = safeErrorMessages[failure.code];
    if (message === undefined || !Number.isFinite(now.getTime())) {
      throw new Error("JOB_FAILURE_INVALID");
    }
    const deadLetter = failure.permanent || claim.attempt >= claim.maxAttempts;
    const calculatedRunAt = deadLetter ? now : nextAttempt(claim.attempt, now, random);
    const requestedRetryAt = failure.retryAt;
    if (
      requestedRetryAt !== undefined
      && (!Number.isFinite(requestedRetryAt.getTime())
        || requestedRetryAt <= now
        || requestedRetryAt.getTime() > now.getTime() + MAX_BACKOFF_MS)
    ) throw new Error("JOB_FAILURE_INVALID");
    const runAt = deadLetter
      ? now
      : requestedRetryAt !== undefined && requestedRetryAt > calculatedRunAt
      ? requestedRetryAt
      : calculatedRunAt;
    const result = await this.database.pool.query<{ transitioned: boolean }>(
      "select public.syntholo_fail_job($1,$2,$3,$4,$5,$6,$7,$8,$9) as transitioned",
      [
        claim.id,
        claim.workerId,
        claim.attempt,
        claim.claimGeneration,
        claim.claimToken,
        now,
        failure.code,
        message,
        deadLetter ? null : runAt,
      ],
    );
    if (!result.rows[0]?.transitioned) return { kind: "stale_claim" };
    return deadLetter
      ? { kind: "dead_lettered" }
      : { kind: "retry_scheduled", runAt };
  }
}

function assertLiveFence(claim: ClaimedJob, now: Date): void {
  if (
    !canonicalUuidPattern.test(claim.id)
    || !canonicalUuidPattern.test(claim.claimToken)
    || !workerPattern.test(claim.workerId)
    || !Number.isInteger(claim.attempt)
    || claim.attempt < 1
    || !Number.isInteger(claim.claimGeneration)
    || claim.claimGeneration < 1
    || !Number.isFinite(now.getTime())
  ) {
    throw new Error("JOB_TRANSITION_INPUT_INVALID");
  }
}
