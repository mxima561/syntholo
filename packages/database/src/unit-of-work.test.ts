import { describe, expect, it, vi } from "vitest";
import { createUnitOfWork } from "./unit-of-work.js";

describe("UnitOfWork Commerce boundary", () => {
  it("provides one frozen Commerce repository inside the transaction lifetime", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const database = {
      transaction: async <T>(
        operation: (transaction: { execute: typeof execute }) => Promise<T>,
      ) => operation({ execute }),
    };
    const unitOfWork = createUnitOfWork(database as never, {
      accountId: null,
      actor: {
        actorId: "10000000-0000-4000-8000-000000000001",
        authenticatedAt: new Date("2026-08-15T16:00:00.000Z"),
        kind: "staff",
        permissions: ["commerce:write"],
        role: "admin",
        staffId: "10000000-0000-4000-8000-000000000002",
        accessUserId: "staff_commerce_test",
      },
      clock: { now: () => new Date("2026-08-15T16:00:00.000Z") },
      correlationId: "10000000-0000-4000-8000-000000000003",
    });

    await unitOfWork.transaction(async (transaction) => {
      expect(transaction.commerce).toBeDefined();
      expect(Object.isFrozen(transaction.commerce)).toBe(true);
      expect(Object.getOwnPropertyNames(transaction.commerce)).toEqual([]);
    });
  });
});
