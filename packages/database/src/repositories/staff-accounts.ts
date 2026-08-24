import { StaffAccountListResponseSchema, type StaffAccountSummary } from "@syntholo/contracts/staff";
import type { Database } from "../client.js";
import {
  acquireMemberReadClient,
  destroyMemberReadLease,
  isMemberReadDeadlineError,
  MEMBER_READ_DEADLINES,
  memberReadParentDeadline,
  runMemberReadCleanupQuery,
  runMemberReadQuery,
  translateMemberReadDependencyError,
} from "../member-read-deadlines.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ListAccountsInput = Readonly<{
  actorId: string; correlationId: string; query?: string;
}>;

export class StaffAccountsRepository {
  constructor(private readonly database: Database) {}

  async listAccounts(input: ListAccountsInput, parentDeadline = memberReadParentDeadline()): Promise<readonly StaffAccountSummary[]> {
    if (!uuid.test(input.actorId) || !uuid.test(input.correlationId)) throw new Error("LEARNING_ADMIN_COMMAND_INVALID");
    let lease: Awaited<ReturnType<typeof acquireMemberReadClient>> | undefined;
    let open = false;
    try {
      lease = await acquireMemberReadClient(this.database.pool, performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs, parentDeadline);
      const query = <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) => runMemberReadQuery<T>(lease!, performance.now() + MEMBER_READ_DEADLINES.queryMs, parentDeadline, text, params);
      await query("begin"); open = true;
      await query("select set_config('app.actor_kind','staff',true), set_config('app.actor_id',$1,true), set_config('app.correlation_id',$2,true)", [input.actorId, input.correlationId]);
      const result = await query<{ result: unknown }>(
        "select public.syntholo_staff_list_accounts_v1($1) result",
        [input.query ?? null],
      );
      const parsed = StaffAccountListResponseSchema.safeParse(result.rows[0]?.result);
      if (!parsed.success) throw new Error("LEARNING_ADMIN_COMMAND_RESULT_INVALID");
      await query("commit"); open = false;
      return Object.freeze(parsed.data.accounts);
    } catch (error) {
      if (open && lease !== undefined && !lease.destroyed) {
        const acquiredLease = lease;
        await runMemberReadCleanupQuery(acquiredLease, MEMBER_READ_DEADLINES.cleanupMs, "rollback").catch(() => destroyMemberReadLease(acquiredLease));
      }
      if (isMemberReadDeadlineError(error)) throw translateMemberReadDependencyError(error);
      throw new Error("LEARNING_ADMIN_COMMAND_FAILED");
    } finally {
      if (lease !== undefined && !lease.destroyed) lease.release();
    }
  }
}
