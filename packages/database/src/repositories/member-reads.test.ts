import type { MemberActor } from "@syntholo/domain";
import { describe, expect, it, vi } from "vitest";
import { AccountRepository } from "./accounts.js";
import { MemberEntitlementReadRepository } from "./member-entitlements.js";

const accountId = "10000000-0000-4000-8000-000000000001";
const actor: MemberActor = {
  kind: "member",
  accountId,
  actorId: "20000000-0000-4000-8000-000000000001",
  membershipId: "30000000-0000-4000-8000-000000000001",
  clerkUserId: "user_test",
  role: "owner",
  authenticatedAt: new Date("2026-08-14T16:00:00.000Z"),
};

function databaseWithClient(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  const once = vi.fn();
  return {
    database: {
      pool: { connect: vi.fn(async () => ({ query, release, once })) },
    },
    release,
  };
}

describe("bounded member repositories", () => {
  it("reads the scoped account in a bounded transaction and releases once", async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      void values;
      if (text.startsWith("select id, name")) {
        return { rows: [{
          id: accountId,
          name: "Acme Advisory",
          status: "active",
          owner_established_at: null,
          created_at: new Date("2026-01-01T00:00:00.000Z"),
          updated_at: new Date("2026-01-01T00:00:00.000Z"),
        }] };
      }
      return { rows: [] };
    });
    const fixture = databaseWithClient(query);
    const repository = new AccountRepository(fixture.database as never);

    await expect(repository.getById({ accountId }, accountId)).resolves.toMatchObject({
      id: accountId,
      name: "Acme Advisory",
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "begin read only",
      "select set_config('app.account_id',$1,true)",
      expect.stringMatching(/^select id, name/u),
      "commit",
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([accountId]);
    expect(query.mock.calls[2]?.[1]).toEqual([accountId, accountId]);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.release).toHaveBeenCalledWith();
  });

  it("acquires the shared entitlement lock without a blocking lock call", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("pg_try_advisory_lock_shared")) {
        return { rows: [{ locked: true }] };
      }
      if (text.includes("syntholo_member_entitlement_snapshot")) {
        return { rows: [{ snapshot: { grants: [], holds: [], seats: [] } }] };
      }
      if (text.includes("pg_advisory_unlock_shared")) {
        return { rows: [{ unlocked: true }] };
      }
      return { rows: [] };
    });
    const fixture = databaseWithClient(query);
    const repository = new MemberEntitlementReadRepository(
      fixture.database as never,
      { now: () => new Date("2026-08-14T16:00:00.000Z") },
    );

    await expect(repository.getEffectiveAccess(actor)).resolves.toMatchObject({
      accountId,
      capabilities: { academy_course: false },
    });
    const sql = query.mock.calls.map(([text]) => String(text));
    expect(sql.some((text) => text.includes("pg_try_advisory_lock_shared"))).toBe(true);
    expect(sql.some((text) => /pg_advisory_lock_shared\(/u.test(text))).toBe(false);
    expect(sql.indexOf("begin isolation level repeatable read read only"))
      .toBeGreaterThan(sql.findIndex((text) => text.includes("pg_try_advisory_lock_shared")));
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("fails with the repository-owned lock sentinel when shared-lock polling expires", async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(async (text: string) => text.includes("pg_try_advisory_lock_shared")
        ? { rows: [{ locked: false }] }
        : { rows: [] });
      const fixture = databaseWithClient(query);
      const repository = new MemberEntitlementReadRepository(
        fixture.database as never,
        { now: () => new Date("2026-08-14T16:00:00.000Z") },
      );
      const pending = repository.getEffectiveAccess(
        actor,
        performance.now() + 8_000,
      );
      const rejected = expect(pending).rejects.toMatchObject({ kind: "lock_timeout" });
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(fixture.release).toHaveBeenCalledExactlyOnceWith();
    } finally {
      vi.useRealTimers();
    }
  });
});
