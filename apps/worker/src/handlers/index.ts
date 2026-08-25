import type { DatabaseClient, JobRecord } from "@syntholo/db";
import { markOutboxPublished } from "@syntholo/db";

export type JobHandler = (job: JobRecord, db: DatabaseClient, now: Date) => Promise<void>;

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

export async function handleOutboxPublish(job: JobRecord, db: DatabaseClient, now: Date) {
  const outboxId = typeof job.payload.outboxId === "string" ? job.payload.outboxId : "";
  if (!outboxId) fail("INVALID_PAYLOAD", "outbox.publish job is missing outboxId");
  await markOutboxPublished(db, outboxId, now);
}

export const defaultJobHandlers: Record<string, JobHandler> = {
  "outbox.publish": handleOutboxPublish,
};
