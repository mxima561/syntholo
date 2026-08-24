import {
  EnrollmentGrantResponseSchema,
  LearningAdminConflictCodeSchema,
  type LearningAdminConflictCode,
} from "@syntholo/contracts/content";
import { createHash } from "node:crypto";
import type { Database } from "../client.js";
import {
  acquireMemberReadClient,
  destroyMemberReadLease,
  isMemberReadDeadlineError,
  MEMBER_READ_DEADLINES,
  memberReadParentDeadline,
  runMemberReadCleanupQuery,
  runMemberReadLockQuery,
  runMemberReadQuery,
  translateMemberReadDependencyError,
} from "../member-read-deadlines.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class LearningAdminCommandConflictError extends Error {
  readonly code: LearningAdminConflictCode;
  constructor(code: LearningAdminConflictCode) {
    super(code);
    this.name = "LearningAdminCommandConflictError";
    this.code = code;
  }
}

function conflictFrom(error: unknown): LearningAdminCommandConflictError | null {
  const parsed = LearningAdminConflictCodeSchema.safeParse(
    error instanceof Error ? error.message : undefined,
  );
  return parsed.success ? new LearningAdminCommandConflictError(parsed.data) : null;
}

export type GrantEnrollmentInput = Readonly<{
  actorId: string; correlationId: string;
  accountId: string; courseId: string; reason: string; idempotencyKey: string;
}>;

export class StaffLearningAdminRepository {
  constructor(private readonly database: Database) {}

  async grantEnrollment(input: GrantEnrollmentInput, parentDeadline = memberReadParentDeadline()) {
    if (!uuid.test(input.actorId) || !uuid.test(input.correlationId) || !uuid.test(input.accountId) || !uuid.test(input.courseId)) {
      throw new Error("LEARNING_ADMIN_COMMAND_INVALID");
    }
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) => runMemberReadQuery<T>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, params);
      const lockQuery = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) => runMemberReadLockQuery<T>(lease!, performance.now() + MEMBER_READ_DEADLINES.lockMs, parentDeadline, text, params);
      await query("begin"); open = true;
      await query("select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)", [input.actorId, input.correlationId]);
      const requestHash = createHash("sha256").update(JSON.stringify({
        accountId: input.accountId, courseId: input.courseId, reason: input.reason,
      }), "utf8").digest("hex");
      const result = await lockQuery<{ result: unknown }>(
        "select public.syntholo_learning_admin_grant_enrollment_v1($1,$2,$3,$4,$5) result",
        [input.accountId, input.courseId, input.reason, input.idempotencyKey, requestHash],
      );
      const parsed = EnrollmentGrantResponseSchema.safeParse(result.rows[0]?.result);
      if (!parsed.success) throw new Error("LEARNING_ADMIN_COMMAND_RESULT_INVALID");
      await query("commit"); open = false;
      return Object.freeze(parsed.data);
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback").catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      const conflict = conflictFrom(error);
      if (conflict) throw conflict;
      throw new Error("LEARNING_ADMIN_COMMAND_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }
}
