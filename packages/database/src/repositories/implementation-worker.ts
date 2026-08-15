import { z } from "zod";
import type { Database } from "../client.js";
import {
  acquireMemberReadClient,
  DatabaseDependencyUnavailableError,
  destroyMemberReadLease,
  isMemberReadDeadlineError,
  MEMBER_READ_DEADLINES,
  memberReadParentDeadline,
  runMemberReadLockQuery,
  translateMemberReadDependencyError,
  type MemberReadClientLease,
} from "../member-read-deadlines.js";

const InputSchema = z.object({
  eventId: z.string().uuid(),
  handlerName: z.literal("implementation.completion_recompute"),
}).strict();

export class ImplementationCompletionInputError extends Error {
  constructor() {
    super("IMPLEMENTATION_COMPLETION_INPUT_INVALID");
    this.name = "ImplementationCompletionInputError";
  }
}

export class WorkerImplementationRepository {
  constructor(private readonly database: Database) {}

  async recordCourseCompletion(
    input: z.input<typeof InputSchema>,
    signal?: AbortSignal,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<Readonly<{ kind: "recorded" | "duplicate" }>> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) throw new ImplementationCompletionInputError();
    let lease: MemberReadClientLease | undefined;
    try {
      if (signal?.aborted === true) throw new DatabaseDependencyUnavailableError("parent_timeout");
      const acquisition = acquireMemberReadClient(
        this.database.pool,
        performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs,
        parentDeadline,
      );
      const acquired = signal === undefined ? { kind: "value" as const, value: await acquisition } : await raceAbort(acquisition, signal);
      if (acquired.kind === "aborted") {
        void acquisition.then((lateLease) => destroyMemberReadLease(lateLease).catch(() => undefined), () => undefined);
        throw new DatabaseDependencyUnavailableError("parent_timeout");
      }
      lease = acquired.value;
      const query = runMemberReadLockQuery<{ outcome: unknown }>(
        lease,
        performance.now() + MEMBER_READ_DEADLINES.lockMs,
        parentDeadline,
        "select public.syntholo_implementation_record_course_completion_v1($1,$2) outcome",
        [parsed.data.eventId, parsed.data.handlerName],
      );
      const queried = signal === undefined ? { kind: "value" as const, value: await query } : await raceAbort(query, signal);
      if (queried.kind === "aborted") {
        void query.catch(() => undefined);
        await destroyMemberReadLease(lease);
        throw new DatabaseDependencyUnavailableError("parent_timeout");
      }
      const outcome = z.enum(["recorded", "duplicate"]).safeParse(queried.value.rows[0]?.outcome);
      if (!outcome.success) throw new Error("IMPLEMENTATION_COMPLETION_RESULT_INVALID");
      return Object.freeze({ kind: outcome.data });
    } catch (error) {
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      if (error instanceof Error && error.message === "IMPLEMENTATION_EVENT_INPUT_INVALID") {
        throw new ImplementationCompletionInputError();
      }
      throw error;
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<
  Readonly<{ kind: "value"; value: T }> | Readonly<{ kind: "aborted" }>
> {
  if (signal.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => { if (!settled) { settled = true; resolve({ kind: "aborted" }); } };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ kind: "value", value });
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}
