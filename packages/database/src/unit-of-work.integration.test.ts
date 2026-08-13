import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accounts } from "./schema/index.js";
import {
  createUnitOfWork,
  withAccountScope,
} from "./unit-of-work.js";
import {
  createTestDatabaseHarness,
  type TestDatabaseHarness,
} from "../../testing/src/database.js";

describe("database transactions", () => {
  let harness: TestDatabaseHarness;

  beforeAll(async () => {
    harness = await createTestDatabaseHarness();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("rolls back every write when a UnitOfWork transaction fails", async () => {
    const unitOfWork = createUnitOfWork(harness.database);

    await expect(
      unitOfWork.transaction(async (transaction) => {
        await transaction.db.insert(accounts).values({
          name: "Must roll back",
        });
        await transaction.db.insert(accounts).values({
          name: "Must also roll back",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const result = await harness.database.pool.query<{ count: string }>(
      "select count(*)::text as count from accounts",
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("sets the account scope inside a committing transaction", async () => {
    const accountId = await harness.factories.account(harness.database);

    const scoped = await withAccountScope(
      harness.database,
      accountId,
      async (transaction) => {
        const setting = await transaction.execute<{ accountId: string }>(
          sql`select current_setting('app.account_id') as "accountId"`,
        );
        const rows = await transaction
          .update(accounts)
          .set({ name: "Scoped transaction account" })
          .where(eq(accounts.id, accountId))
          .returning({ name: accounts.name });
        return {
          accountId: setting.rows[0]?.accountId,
          name: rows[0]?.name,
        };
      },
    );

    expect(scoped).toEqual({
      accountId,
      name: "Scoped transaction account",
    });
  });
});
