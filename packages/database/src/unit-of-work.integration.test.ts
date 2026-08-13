import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

  it("runs an account callback inside a committing transaction", async () => {
    const accountId = await harness.factories.account(harness.database);

    const insertedName = await withAccountScope(
      harness.database,
      accountId,
      async (transaction) => {
        const rows = await transaction
          .insert(accounts)
          .values({ name: "Scoped transaction account" })
          .returning({ name: accounts.name });
        return rows[0]?.name;
      },
    );

    expect(insertedName).toBe("Scoped transaction account");
  });
});
