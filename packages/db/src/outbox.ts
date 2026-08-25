import { nextAttempt, type DomainEvent } from "@syntholo/domain";
import type { DatabaseClient } from "./client";
import { withSystemScope } from "./scope";

export type AuditActorKind = "member" | "staff" | "system";

export type JobStatus = "queued" | "running" | "completed" | "dead_letter";

export type JobRecord = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempt: number;
  maxAttempts: number;
  runAt: Date;
  workerId: string | null;
  claimedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export const OUTBOX_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('member', 'staff', 'system')),
    actor_id TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target_type, target_id)`,
  `CREATE OR REPLACE FUNCTION reject_audit_events_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$`,
  `DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events`,
  `CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_audit_events_mutation()`,
  `DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events`,
  `CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_audit_events_mutation()`,
  `CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name TEXT NOT NULL,
    account_id UUID REFERENCES accounts(id),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'dead_letter')),
    priority INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    worker_id TEXT,
    claimed_at TIMESTAMPTZ,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, run_at) WHERE status = 'queued'`,
  `CREATE TABLE IF NOT EXISTS handler_receipts (
    handler_name TEXT NOT NULL,
    event_id UUID NOT NULL REFERENCES outbox_events(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (handler_name, event_id)
  )`,
];

const MAX_ERROR_CODE = 64;
const MAX_ERROR_MESSAGE = 500;

export async function bootstrapOutboxModel(db: DatabaseClient) {
  for (const statement of OUTBOX_SCHEMA_SQL) {
    await db.unsafe(statement);
  }
}

export async function mutateWithEvent<T>(work: (db: DatabaseClient) => Promise<T>, db?: DatabaseClient): Promise<T> {
  if (db) return work(db);
  return withSystemScope(work);
}

function jsonParam(db: DatabaseClient, payload: Readonly<Record<string, unknown>>) {
  return db.json(JSON.parse(JSON.stringify(payload)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function mapJob(row: Record<string, unknown>): JobRecord {
  const status = row.status;
  return {
    id: String(row.id),
    kind: String(row.kind),
    payload: asRecord(row.payload),
    status:
      status === "running" || status === "completed" || status === "dead_letter" ? status : "queued",
    priority: Number(row.priority ?? 0),
    attempt: Number(row.attempt ?? 0),
    maxAttempts: Number(row.max_attempts ?? 5),
    runAt: new Date(row.run_at as string | Date),
    workerId: row.worker_id ? String(row.worker_id) : null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at as string | Date) : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
  };
}

export function safeJobErrorMessage(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE);
}

export function safeJobErrorCode(code: string) {
  return code.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CODE) || "JOB_FAILED";
}

export async function appendAudit(
  db: DatabaseClient,
  input: {
    actorKind: AuditActorKind;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    payload?: Readonly<Record<string, unknown>>;
  },
) {
  const [row] = await db`
    INSERT INTO audit_events (actor_kind, actor_id, action, target_type, target_id, payload)
    VALUES (
      ${input.actorKind},
      ${input.actorId},
      ${input.action},
      ${input.targetType},
      ${input.targetId},
      ${jsonParam(db, input.payload ?? {})}
    )
    RETURNING id
  `;
  return { id: String(row.id) };
}

export async function enqueueJob(
  db: DatabaseClient,
  input: {
    kind: string;
    payload: Readonly<Record<string, unknown>>;
    runAt?: Date;
    priority?: number;
    maxAttempts?: number;
  },
): Promise<JobRecord> {
  const runAt = input.runAt ?? new Date();
  const priority = input.priority ?? 0;
  const maxAttempts = input.maxAttempts ?? 5;
  const [row] = await db`
    INSERT INTO jobs (kind, payload, status, priority, max_attempts, run_at, updated_at)
    VALUES (
      ${input.kind},
      ${jsonParam(db, input.payload)},
      ${"queued"},
      ${priority},
      ${maxAttempts},
      ${runAt},
      ${runAt}
    )
    RETURNING id, kind, payload, status, priority, attempt, max_attempts, run_at, worker_id, claimed_at, last_error_code, last_error_message
  `;
  return mapJob(row);
}

export async function enqueueOutbox(db: DatabaseClient, event: DomainEvent) {
  const accountId = event.accountId ? event.accountId : null;
  const [row] = await db`
    INSERT INTO outbox_events (event_name, account_id, payload)
    VALUES (${event.eventName}, ${accountId}, ${jsonParam(db, event.payload)})
    RETURNING id
  `;
  const id = String(row.id);
  await enqueueJob(db, {
    kind: "outbox.publish",
    payload: { outboxId: id },
  });
  return { id };
}

export async function claimJobs(
  db: DatabaseClient,
  input: { limit: number; workerId: string; now: Date },
): Promise<JobRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
  const staleBefore = new Date(input.now.getTime() - 15 * 60 * 1000);
  const rows = await db`
    WITH picked AS (
      SELECT id
      FROM jobs
      WHERE (status = 'queued' AND run_at <= ${input.now})
         OR (status = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ${staleBefore})
      ORDER BY priority DESC, run_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE jobs AS j
    SET
      status = 'running',
      worker_id = ${input.workerId},
      claimed_at = ${input.now},
      updated_at = ${input.now}
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.id, j.kind, j.payload, j.status, j.priority, j.attempt, j.max_attempts, j.run_at, j.worker_id, j.claimed_at, j.last_error_code, j.last_error_message
  `;
  return rows.map(mapJob);
}

export async function completeJob(db: DatabaseClient, jobId: string) {
  await db`
    UPDATE jobs
    SET status = 'completed', updated_at = now()
    WHERE id = ${jobId}
  `;
}

export async function failJob(
  db: DatabaseClient,
  jobId: string,
  input: { code: string; message: string; now: Date },
) {
  const [job] = await db`
    SELECT attempt, max_attempts, status FROM jobs WHERE id = ${jobId}
  `;
  if (!job) return;
  if (job.status !== "queued" && job.status !== "running") return;

  const currentAttempt = Number(job.attempt ?? 0);
  const nextAttemptNumber = currentAttempt + 1;
  const maxAttempts = Number(job.max_attempts ?? 5);
  const code = safeJobErrorCode(input.code);
  const message = safeJobErrorMessage(input.message);

  if (nextAttemptNumber >= maxAttempts) {
    await db`
      UPDATE jobs
      SET
        status = 'dead_letter',
        attempt = ${nextAttemptNumber},
        last_error_code = ${code},
        last_error_message = ${message},
        worker_id = NULL,
        updated_at = ${input.now}
      WHERE id = ${jobId}
    `;
    return;
  }

  const runAt = nextAttempt(currentAttempt, input.now);
  await db`
    UPDATE jobs
    SET
      status = 'queued',
      attempt = ${nextAttemptNumber},
      run_at = ${runAt},
      last_error_code = ${code},
      last_error_message = ${message},
      worker_id = NULL,
      claimed_at = NULL,
      updated_at = ${input.now}
    WHERE id = ${jobId}
  `;
}

export async function recordHandlerReceipt(db: DatabaseClient, handlerName: string, eventId: string) {
  await db`
    INSERT INTO handler_receipts (handler_name, event_id)
    VALUES (${handlerName}, ${eventId})
    ON CONFLICT (handler_name, event_id) DO NOTHING
  `;
}

export async function markOutboxPublished(db: DatabaseClient, outboxId: string, now: Date) {
  await db`
    UPDATE outbox_events
    SET published_at = ${now}
    WHERE id = ${outboxId} AND published_at IS NULL
  `;
  await recordHandlerReceipt(db, "outbox.publish", outboxId);
}
