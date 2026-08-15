import { describe, expect, it, vi } from "vitest";
import { TransactionAccountRepository } from "./transaction-accounts.js";

describe("TransactionAccountRepository account names", () => {
  it("persists the canonical NFC value returned by the shared writer", async () => {
    const set = vi.fn(() => ({
      where: () => ({ returning: async () => [{ name: "Café" }] }),
    }));
    const repository = new TransactionAccountRepository(
      { update: () => ({ set }) } as never,
      {
        accountId: "10000000-0000-4000-8000-000000000001",
        actor: { kind: "system", actorId: "test" },
        clock: { now: () => new Date("2026-08-14T16:00:00.000Z") },
        correlationId: "20000000-0000-4000-8000-000000000001",
      },
      { run: (operation: () => Promise<unknown>) => operation() } as never,
    );

    await expect(repository.rename("  Cafe\u0301  ")).resolves.toBe("Café");
    expect(set).toHaveBeenCalledWith({ name: "Café", nameStatus: "confirmed" });
  });

  it.each(["\t", "\u00a0", "\u200b", "\ufdd0", "a".repeat(256)])(
    "rejects invalid account name %j before issuing an update",
    async (suffix) => {
      const update = vi.fn();
      const repository = new TransactionAccountRepository(
        { update } as never,
        {
          accountId: "10000000-0000-4000-8000-000000000001",
          actor: { kind: "system", actorId: "test" },
          clock: { now: () => new Date("2026-08-14T16:00:00.000Z") },
          correlationId: "20000000-0000-4000-8000-000000000001",
        },
        { run: (operation: () => Promise<unknown>) => operation() } as never,
      );

      await expect(repository.rename(`Acme${suffix}`)).rejects.toThrow("ACCOUNT_NAME_INVALID");
      expect(update).not.toHaveBeenCalled();
    },
  );
});
