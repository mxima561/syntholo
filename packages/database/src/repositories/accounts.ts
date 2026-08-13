import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { accounts } from "../schema/index.js";
import { withAccountScope } from "../unit-of-work.js";

export type AccountScope = Readonly<{ accountId: string }>;
export type AccountRecord = typeof accounts.$inferSelect;

export class AccountRepository {
  constructor(private readonly database: Database) {}

  async getById(
    scope: AccountScope,
    id: string,
  ): Promise<AccountRecord | null> {
    return withAccountScope(this.database, scope.accountId, async (transaction) => {
      const rows = await transaction.select().from(accounts).where(and(
        eq(accounts.id, scope.accountId),
        eq(accounts.id, id),
      )).limit(1);
      return rows[0] ?? null;
    });
  }
}
