import type { ClaimedJob, ClassifiedJobFailure } from "@syntholo/database";

export class HandlerFailure extends Error {
  readonly failure: ClassifiedJobFailure;

  constructor(failure: ClassifiedJobFailure) {
    super("WORKER_HANDLER_FAILED");
    this.failure = Object.freeze({
      code: failure.code,
      permanent: failure.permanent,
      ...(failure.retryAt === undefined ? {} : { retryAt: new Date(failure.retryAt) }),
    });
  }
}

export class FatalWorkerConsistencyError extends Error {
  constructor() {
    super("WORKER_TRANSITION_FAILED");
  }
}

export type JobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;

export function createHandlerRegistry(
  handlers: Readonly<Record<string, JobHandler>> = {},
): Readonly<{ handle(job: ClaimedJob, signal: AbortSignal): Promise<void> }> {
  const registered = Object.freeze({ ...handlers });
  return Object.freeze({
    async handle(job: ClaimedJob, signal: AbortSignal): Promise<void> {
      const handler = registered[job.type];
      if (handler === undefined) {
        throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
      }
      try {
        await handler(job, signal);
      } catch (error) {
        if (error instanceof FatalWorkerConsistencyError) throw error;
        if (error instanceof HandlerFailure) throw error;
        throw new HandlerFailure({ code: "JOB_HANDLER_FAILED", permanent: false });
      }
    },
  });
}
