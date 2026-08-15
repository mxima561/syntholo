import type { Database } from "../client.js";
import { accounts } from "../schema/index.js";
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

export type AccountScope = Readonly<{ accountId: string }>;
export type AccountRecord = typeof accounts.$inferSelect;

export class AccountRepository {
  constructor(private readonly database: Database) {}

  async getById(
    scope: AccountScope,
    id: string,
    parentDeadline = memberReadParentDeadline(),
  ): Promise<AccountRecord | null> {
    let lease;
    let transactionOpen = false;
    try {
      lease = await acquireMemberReadClient(
        this.database.pool,
        performance.now() + MEMBER_READ_DEADLINES.poolAcquireMs,
        parentDeadline,
      );
      const query = <TRow extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) => runMemberReadQuery<TRow>(
        lease!,
        performance.now() + MEMBER_READ_DEADLINES.queryMs,
        parentDeadline,
        text,
        values,
      );
      await query("begin read only");
      transactionOpen = true;
      await query(
        "select set_config('app.account_id',$1,true)",
        [scope.accountId],
      );
      const result = await query<{
        id: string;
        name: string;
        name_status: string;
        status: string;
        owner_established_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `select id, name, name_status, status, owner_established_at, created_at, updated_at
         from accounts
         where id = $1 and id = $2
         limit 1`,
        [scope.accountId, id],
      );
      await query("commit");
      transactionOpen = false;
      const row = result.rows[0];
      return row === undefined ? null : {
        id: row.id,
        name: row.name,
        nameStatus: row.name_status,
        status: row.status,
        ownerEstablishedAt: row.owner_established_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      if (lease !== undefined && transactionOpen && !lease.destroyed) {
        await runMemberReadCleanupQuery(
          lease,
          MEMBER_READ_DEADLINES.cleanupMs,
          "rollback",
        ).catch(() => lease!.destroyed
          ? undefined
          : destroyMemberReadLease(lease!, MEMBER_READ_DEADLINES.cleanupMs));
      }
      if (isMemberReadDeadlineError(error)) {
        throw translateMemberReadDependencyError(error);
      }
      throw error;
    } finally {
      lease?.release();
    }
  }
}
