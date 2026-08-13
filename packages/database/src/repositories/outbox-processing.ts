import type { Database } from "../client.js";
import type { ClaimedJob } from "./jobs.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const workerPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type ClaimedOutboxEvent = Readonly<{
  attempt: number;
  claimGeneration: number;
  claimToken: string;
  eventId: string;
  eventType: string;
  leaseExpiresAt: Date;
  maxAttempts: number;
  workerId: string;
}>;

export class PermanentOutboxDispatchError extends Error {
  constructor() {
    super("OUTBOX_DISPATCH_CONFLICT");
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

export type HandlerReceiptClaim = Readonly<{
  accountId: string | null;
  attempt: number;
  claimGeneration: number;
  claimToken: string;
  eventId: string;
  handlerName: string;
  jobAttempt: number;
  jobClaimGeneration: number;
  jobClaimToken: string;
  jobId: string;
  kind: "acquired";
  leaseExpiresAt: Date;
  workerId: string;
}>;

type OutboxRow = {
  attempts: number;
  claim_generation: number;
  claim_token: string;
  event_id: string;
  type: string;
  lease_expires_at: Date;
  max_attempts: number;
  worker_id: string;
};

function assertTime(value: Date, code: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(code);
}

function assertFence(claim: ClaimedOutboxEvent, now: Date): void {
  if (
    !uuidPattern.test(claim.eventId)
    || !uuidPattern.test(claim.claimToken)
    || !workerPattern.test(claim.workerId)
    || !Number.isInteger(claim.attempt)
    || claim.attempt < 1
    || !Number.isInteger(claim.claimGeneration)
    || claim.claimGeneration < 1
  ) throw new Error("OUTBOX_TRANSITION_INPUT_INVALID");
  assertTime(now, "OUTBOX_TRANSITION_INPUT_INVALID");
}

export class OutboxProcessorRepository {
  readonly #database: Database;
  readonly #leaseMs: number;

  constructor(database: Database, options: Readonly<{ leaseMs: number }>) {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs < 1 || options.leaseMs > 3_600_000) {
      throw new Error("OUTBOX_REPOSITORY_CONFIG_INVALID");
    }
    this.#database = database;
    this.#leaseMs = options.leaseMs;
    Object.freeze(this);
  }

  async claim(limit: number, workerId: string, now: Date): Promise<readonly ClaimedOutboxEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !workerPattern.test(workerId)) {
      throw new Error("OUTBOX_CLAIM_INPUT_INVALID");
    }
    assertTime(now, "OUTBOX_CLAIM_INPUT_INVALID");
    const result = await this.#database.pool.query<OutboxRow>(
      "select * from public.syntholo_claim_outbox($1,$2,$3,$4)",
      [limit, workerId, now, this.#leaseMs],
    );
    return result.rows.map((row) => Object.freeze({
      attempt: row.attempts,
      claimGeneration: row.claim_generation,
      claimToken: row.claim_token,
      eventId: row.event_id,
      eventType: row.type,
      leaseExpiresAt: row.lease_expires_at,
      maxAttempts: row.max_attempts,
      workerId: row.worker_id,
    }));
  }

  async dispatch(
    claim: ClaimedOutboxEvent,
    handlers: readonly string[],
    now: Date,
  ): Promise<Readonly<{ kind: "published"; jobsCreated: number }> | Readonly<{ kind: "stale_claim" }>> {
    assertFence(claim, now);
    if (
      handlers.length < 1
      || handlers.length > 32
      || new Set(handlers).size !== handlers.length
      || handlers.some((handler) => !workerPattern.test(handler))
    ) throw new Error("OUTBOX_TRANSITION_INPUT_INVALID");
    let result;
    try {
      result = await this.#database.pool.query<{ dispatched: number }>(
        "select public.syntholo_dispatch_outbox($1,$2,$3,$4,$5,$6,$7) as dispatched",
        [claim.eventId, claim.workerId, claim.attempt, claim.claimGeneration,
          claim.claimToken, now, handlers],
      );
    } catch (error) {
      if (postgresCode(error) === "23505") throw new PermanentOutboxDispatchError();
      throw error;
    }
    const count = result.rows[0]?.dispatched;
    return count === undefined || count < 0
      ? { kind: "stale_claim" }
      : { jobsCreated: count, kind: "published" };
  }

  async fail(
    claim: ClaimedOutboxEvent,
    now: Date,
    failure: Readonly<{ permanent: boolean }>,
    random: number,
  ): Promise<Readonly<{
    kind: "dead_lettered" | "retry_scheduled" | "stale_claim";
    runAt?: Date;
  }>> {
    assertFence(claim, now);
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new Error("OUTBOX_TRANSITION_INPUT_INVALID");
    }
    const terminal = failure.permanent || claim.attempt >= claim.maxAttempts;
    const base = Math.min(3_600_000, 1_000 * 2 ** (claim.attempt - 1));
    const runAt = terminal
      ? null
      : new Date(now.getTime() + Math.min(3_600_000, base + Math.floor(base * 0.25 * random)));
    const result = await this.#database.pool.query<{ transitioned: boolean }>(
      "select public.syntholo_fail_outbox($1,$2,$3,$4,$5,$6,$7) as transitioned",
      [claim.eventId, claim.workerId, claim.attempt, claim.claimGeneration,
        claim.claimToken, now, runAt],
    );
    if (!result.rows[0]?.transitioned) return { kind: "stale_claim" };
    return terminal
      ? { kind: "dead_lettered" }
      : { kind: "retry_scheduled", runAt: runAt! };
  }
}

type ReceiptRow = {
  account_id: string | null;
  attempt: number;
  claim_generation: number;
  claim_token: string;
  kind: "acquired" | "busy" | "completed";
  lease_expires_at: Date | null;
  event_id: string;
  handler_name: string;
};

export class HandlerReceiptRepository {
  readonly #database: Database;
  readonly #leaseMs: number;

  constructor(database: Database, options: Readonly<{ leaseMs: number }>) {
    if (!Number.isInteger(options.leaseMs) || options.leaseMs < 1 || options.leaseMs > 3_600_000) {
      throw new Error("HANDLER_RECEIPT_CONFIG_INVALID");
    }
    this.#database = database;
    this.#leaseMs = options.leaseMs;
    Object.freeze(this);
  }

  async acquire(
    job: ClaimedJob,
    now: Date,
  ): Promise<HandlerReceiptClaim | Readonly<{ kind: "busy"; leaseExpiresAt: Date }> | Readonly<{ kind: "completed" }>> {
    const eventId = job.payload.eventId;
    const handlerName = job.payload.handlerName;
    if (
      job.type !== "foundation.domain_event_handler.v1"
      || typeof handlerName !== "string"
      || typeof eventId !== "string"
      || !workerPattern.test(handlerName)
      || !uuidPattern.test(eventId)
      || !workerPattern.test(job.workerId)
      || !uuidPattern.test(job.id)
      || !uuidPattern.test(job.claimToken)
      || !Number.isInteger(job.attempt) || job.attempt < 1
      || !Number.isInteger(job.claimGeneration) || job.claimGeneration < 1
    ) throw new Error("HANDLER_RECEIPT_INPUT_INVALID");
    assertTime(now, "HANDLER_RECEIPT_INPUT_INVALID");
    const result = await this.#database.pool.query<ReceiptRow>(
      "select * from public.syntholo_acquire_handler_receipt($1,$2,$3,$4,$5,$6,$7)",
      [job.id, job.workerId, job.attempt, job.claimGeneration, job.claimToken,
        now, this.#leaseMs],
    );
    const row = result.rows[0];
    if (!row || row.kind !== "acquired") {
      if (row?.kind === "completed") return { kind: "completed" };
      if (!(row?.lease_expires_at instanceof Date)) {
        throw new Error("HANDLER_RECEIPT_STATE_INVALID");
      }
      return { kind: "busy", leaseExpiresAt: row.lease_expires_at };
    }
    if (row.lease_expires_at === null) throw new Error("HANDLER_RECEIPT_STATE_INVALID");
    return Object.freeze({
      accountId: row.account_id,
      attempt: row.attempt,
      claimGeneration: row.claim_generation,
      claimToken: row.claim_token,
      eventId,
      handlerName,
      jobAttempt: job.attempt,
      jobClaimGeneration: job.claimGeneration,
      jobClaimToken: job.claimToken,
      jobId: job.id,
      kind: "acquired" as const,
      leaseExpiresAt: row.lease_expires_at,
      workerId: job.workerId,
    });
  }

  async complete(
    claim: HandlerReceiptClaim,
    now: Date,
  ): Promise<Readonly<{ kind: "completed" | "stale_claim" }>> {
    this.#assertClaim(claim, now);
    const result = await this.#database.pool.query<{ transitioned: boolean }>(
      "select public.syntholo_complete_handler_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as transitioned",
      [claim.handlerName, claim.eventId, claim.jobId, claim.workerId,
        claim.jobAttempt, claim.jobClaimGeneration, claim.jobClaimToken,
        claim.attempt, claim.claimGeneration, claim.claimToken, now],
    );
    return { kind: result.rows[0]?.transitioned ? "completed" : "stale_claim" };
  }

  async abandon(
    claim: HandlerReceiptClaim,
    now: Date,
  ): Promise<Readonly<{ kind: "abandoned" | "stale_claim" }>> {
    this.#assertClaim(claim, now);
    const result = await this.#database.pool.query<{ transitioned: boolean }>(
      "select public.syntholo_abandon_handler_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as transitioned",
      [claim.handlerName, claim.eventId, claim.jobId, claim.workerId,
        claim.jobAttempt, claim.jobClaimGeneration, claim.jobClaimToken,
        claim.attempt, claim.claimGeneration, claim.claimToken, now],
    );
    return { kind: result.rows[0]?.transitioned ? "abandoned" : "stale_claim" };
  }

  #assertClaim(
    claim: HandlerReceiptClaim,
    now: Date,
  ): void {
    if (
      !workerPattern.test(claim.handlerName)
      || !uuidPattern.test(claim.eventId)
      || !uuidPattern.test(claim.jobId)
      || !workerPattern.test(claim.workerId)
      || !uuidPattern.test(claim.claimToken)
      || !uuidPattern.test(claim.jobClaimToken)
      || !Number.isInteger(claim.jobAttempt)
      || claim.jobAttempt < 1
      || !Number.isInteger(claim.jobClaimGeneration)
      || claim.jobClaimGeneration < 1
      || !Number.isInteger(claim.attempt)
      || claim.attempt < 1
      || !Number.isInteger(claim.claimGeneration)
      || claim.claimGeneration < 1
    ) throw new Error("HANDLER_RECEIPT_INPUT_INVALID");
    assertTime(now, "HANDLER_RECEIPT_INPUT_INVALID");
  }
}
