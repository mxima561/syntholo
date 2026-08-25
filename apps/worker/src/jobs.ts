import {
  claimJobs,
  completeJob,
  failJob,
  safeJobErrorCode,
  safeJobErrorMessage,
  withSystemScope,
} from "@syntholo/db";
import { defaultJobHandlers, type JobHandler } from "./handlers/index";

export type ProcessJobBatchInput = {
  workerId: string;
  limit: number;
  now: Date;
  handlers?: Record<string, JobHandler>;
};

export type ProcessJobBatchResult = {
  claimed: number;
  completed: number;
  failed: number;
};

function jobErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return safeJobErrorCode(error.code);
  }
  return "JOB_FAILED";
}

function jobErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Job failed.";
  return safeJobErrorMessage(message);
}

export async function processJobBatch(input: ProcessJobBatchInput): Promise<ProcessJobBatchResult> {
  const handlers = input.handlers ?? defaultJobHandlers;
  const claimed = await withSystemScope((db) =>
    claimJobs(db, {
      limit: input.limit,
      workerId: input.workerId,
      now: input.now,
    }),
  );
  let completed = 0;
  let failed = 0;
  for (const job of claimed) {
    try {
      await withSystemScope(async (db) => {
        const handler = handlers[job.kind];
        if (!handler) {
          const error = new Error(`Unknown job kind: ${job.kind}`) as Error & { code: string };
          error.code = "UNKNOWN_KIND";
          throw error;
        }
        await handler(job, db, input.now);
        await completeJob(db, job.id);
      });
      completed += 1;
    } catch (error) {
      await withSystemScope((db) =>
        failJob(db, job.id, {
          code: jobErrorCode(error),
          message: jobErrorMessage(error),
          now: input.now,
        }),
      );
      failed += 1;
    }
  }
  return { claimed: claimed.length, completed, failed };
}
