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
    const accountId = await harness.factories.account(harness.database, { name: "Before" });
    const unitOfWork = createUnitOfWork(harness.database, {
      accountId,
      actor: {
        accountId,
        actorId: "10000000-0000-4000-8000-000000000098",
        authenticatedAt: new Date("2026-08-13T15:00:00.000Z"),
        clerkUserId: "clerk_foundation_test",
        kind: "member",
        membershipId: "10000000-0000-4000-8000-000000000097",
        role: "owner",
      },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    });

    await expect(
      unitOfWork.transaction(async (transaction) => {
        await transaction.accounts.rename("Must roll back");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const result = await harness.database.pool.query<{ name: string }>(
      "select name from accounts where id = $1",
      [accountId],
    );
    expect(result.rows[0]?.name).toBe("Before");
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

  it("invalidates escaped transaction repositories and unfinished builders after commit", async () => {
    const unitOfWork = createUnitOfWork(harness.database, {
      accountId: null,
      actor: {
        actorId: "10000000-0000-4000-8000-000000000098",
        authenticatedAt: new Date("2026-08-13T15:00:00.000Z"),
        kind: "staff",
        permissions: ["foundation:write"],
        role: "admin",
        staffId: "10000000-0000-4000-8000-000000000097",
        workosUserId: "staff_test",
      },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    });
    let escapedRename: (() => Promise<unknown>) | undefined;
    let escapedAppend: (() => Promise<unknown>) | undefined;
    let escapedDecision: (() => Promise<unknown>) | undefined;

    await unitOfWork.transaction(async (transaction) => {
      escapedRename = () => transaction.accounts.rename("Escaped");
      escapedAppend = () => transaction.audit.append({
        action: "foundation_tested",
        payload: { referenceId: "account_1" },
        targetId: null,
        targetType: "foundation",
      });
      escapedDecision = () => transaction.entitlements.recordDecision({
        commandId: "10000000-0000-4000-8000-000000000096",
        checkKind: "capability:academy_course",
        allowed: false,
        reasonCode: "ACADEMY_REQUIRED",
        sourceIds: [],
      });
      expect(Object.isFrozen(transaction.entitlements)).toBe(true);
      expect(Object.getOwnPropertyNames(transaction.entitlements)).toEqual([]);
      expect(() => Object.defineProperty(transaction.entitlements, "metadata", {
        value: { accountId: "20000000-0000-4000-8000-000000000002" },
      })).toThrow();
    });

    await expect(escapedRename?.()).rejects.toThrow(
      "TRANSACTION_CONTEXT_EXPIRED",
    );
    await expect(escapedAppend?.()).rejects.toThrow(
      "TRANSACTION_CONTEXT_EXPIRED",
    );
    await expect(escapedDecision?.()).rejects.toThrow(
      "TRANSACTION_CONTEXT_EXPIRED",
    );
  });

  it("invalidates an escaped unfinished builder after rollback", async () => {
    const unitOfWork = createUnitOfWork(harness.database, {
      accountId: null,
      actor: {
        actorId: "10000000-0000-4000-8000-000000000098",
        authenticatedAt: new Date("2026-08-13T15:00:00.000Z"),
        kind: "staff",
        permissions: ["foundation:write"],
        role: "admin",
        staffId: "10000000-0000-4000-8000-000000000097",
        workosUserId: "staff_test",
      },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    });
    let escapedRename: (() => Promise<unknown>) | undefined;

    await expect(unitOfWork.transaction(async (transaction) => {
      escapedRename = () => transaction.accounts.rename("Escaped");
      throw new Error("EXPECTED_ROLLBACK");
    })).rejects.toThrow("EXPECTED_ROLLBACK");

    await expect(escapedRename?.()).rejects.toThrow(
      "TRANSACTION_CONTEXT_EXPIRED",
    );
  });

  it("rolls back when a repository promise is started but not awaited", async () => {
    const accountId = await harness.factories.account(harness.database, { name: "Before" });
    const unitOfWork = createUnitOfWork(harness.database, {
      accountId,
      actor: {
        accountId,
        actorId: "10000000-0000-4000-8000-000000000098",
        authenticatedAt: new Date("2026-08-13T15:00:00.000Z"),
        clerkUserId: "clerk_foundation_test",
        kind: "member",
        membershipId: "10000000-0000-4000-8000-000000000097",
        role: "owner",
      },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    });
    let pending: Promise<string> | undefined;

    await expect(unitOfWork.transaction(async (transaction) => {
      pending = transaction.accounts.rename("Escaped promise");
    })).rejects.toThrow("TRANSACTION_OPERATION_NOT_AWAITED");
    await pending?.catch(() => undefined);
    const result = await harness.database.pool.query<{ name: string }>(
      "select name from accounts where id = $1",
      [accountId],
    );
    expect(result.rows[0]?.name).toBe("Before");
  });

  it("rolls back an unawaited entitlement repository operation", async () => {
    const accountId = await harness.factories.account(harness.database);
    const unitOfWork = createUnitOfWork(harness.database, {
      accountId,
      actor: {
        accountId,
        actorId: "10000000-0000-4000-8000-000000000098",
        authenticatedAt: new Date("2026-08-13T15:00:00.000Z"),
        clerkUserId: "clerk_foundation_test",
        kind: "member",
        membershipId: "10000000-0000-4000-8000-000000000097",
        role: "owner",
      },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    });
    let pending: Promise<unknown> | undefined;
    await expect(unitOfWork.transaction(async (transaction) => {
      pending = transaction.entitlements.recordDecision({
        commandId: "10000000-0000-4000-8000-000000000096",
        checkKind: "capability:academy_course",
        allowed: false,
        reasonCode: "ACADEMY_REQUIRED",
        sourceIds: [],
      });
    })).rejects.toThrow("TRANSACTION_OPERATION_NOT_AWAITED");
    await pending?.catch(() => undefined);
    const result = await harness.database.pool.query(
      "select count(*)::int count from access_decision_audit",
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it("rolls back when a fire-and-forget validation failure is not awaited", async () => {
    const accountId = await harness.factories.account(harness.database, { name: "Before" });
    const unitOfWork = createUnitOfWork(harness.database, {
      accountId,
      actor: {
        accountId,
        actorId: "10000000-0000-4000-8000-000000000098",
        authenticatedAt: new Date("2026-08-13T15:00:00.000Z"),
        clerkUserId: "clerk_foundation_test",
        kind: "member",
        membershipId: "10000000-0000-4000-8000-000000000097",
        role: "owner",
      },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    });
    let invalid: Promise<string> | undefined;

    await expect(unitOfWork.transaction(async (transaction) => {
      await transaction.accounts.rename("Must roll back");
      invalid = transaction.audit.append({
        action: "foundation_tested",
        payload: { transcript: "opaque" },
        targetType: "foundation",
      });
    })).rejects.toThrow("TRANSACTION_OPERATION_NOT_AWAITED");
    await invalid?.catch(() => undefined);
    const result = await harness.database.pool.query<{ name: string }>(
      "select name from accounts where id = $1",
      [accountId],
    );
    expect(result.rows[0]?.name).toBe("Before");
  });

  it("snapshots trusted actor and clock properties before callers can mutate their sources", async () => {
    const actor = {
      actorId: "trusted_actor",
      authenticatedAt: new Date("2026-08-13T15:00:00.000Z"),
      kind: "staff" as const,
      permissions: ["foundation:write"],
      role: "admin" as const,
      staffId: "10000000-0000-4000-8000-000000000097",
      workosUserId: "staff_test",
    };
    const clock = { now: () => new Date("2026-08-13T16:00:00.000Z") };
    const unitOfWork = createUnitOfWork(harness.database, {
      accountId: null,
      actor,
      clock,
      correlationId: "10000000-0000-4000-8000-000000000099",
    });
    actor.actorId = "mutated_actor";
    clock.now = () => new Date("2026-08-14T16:00:00.000Z");

    await unitOfWork.transaction(async (transaction) => {
      await transaction.audit.append({
        action: "foundation_tested",
        payload: { referenceId: "account_1" },
        targetId: null,
        targetType: "foundation",
      });
    });

    const result = await harness.database.pool.query(
      "select actor_id, occurred_at from audit_events",
    );
    expect(result.rows).toEqual([{
      actor_id: "trusted_actor",
      occurred_at: new Date("2026-08-13T16:00:00.000Z"),
    }]);
  });

  it("rejects structurally forged actor kinds and oversized actor IDs before SQL", () => {
    expect(() => createUnitOfWork(harness.database, {
      accountId: null,
      actor: { actorId: "forged", kind: "administrator" },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    } as never)).toThrow("TRANSACTION_METADATA_INVALID");

    expect(() => createUnitOfWork(harness.database, {
      accountId: null,
      actor: { actorId: "x".repeat(256), kind: "system" },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    })).toThrow("TRANSACTION_METADATA_INVALID");
    expect(() => createUnitOfWork(harness.database, {
      accountId: null,
      actor: { actorId: "foundation_system", kind: "system" },
      clock: { now: () => new Date("2026-08-13T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000099",
    })).toThrow("TRANSACTION_METADATA_INVALID");
  });
});
