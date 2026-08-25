import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { academyCourse } from "@syntholo/domain";

const TEST_DATABASE_URL = "postgresql://syntholo@localhost:54329/syntholo_test";

async function probeScratchDatabase(): Promise<boolean> {
  const probe = postgres(TEST_DATABASE_URL, { connect_timeout: 2, max: 1, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
}

const canReachScratchDatabase = await probeScratchDatabase();

describe.skipIf(!canReachScratchDatabase)("entitlement authority", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { getReadyDb } = await import("./client");
    await getReadyDb();
  });

  afterAll(async () => {
    if (!canReachScratchDatabase) return;
    const { closeDb } = await import("./client");
    await closeDb();
  });

  async function createUser(email: string) {
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const [row] = await db`
      INSERT INTO app_users (email, first_name, last_name, role)
      VALUES (${email}, ${"Access"}, ${"Tester"}, ${"student"})
      ON CONFLICT (email) DO UPDATE SET first_name = EXCLUDED.first_name
      RETURNING id
    `;
    return String(row.id);
  }

  it("keeps lesson progress after a refund recomputes grants", async () => {
    const {
      applyPurchaseRefund,
      ensureAccountForUser,
      loadEffectiveAccess,
      upsertEntitlementGrant,
      withSystemScope,
    } = await import("./index");
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const stamp = Date.now();
    const userId = await createUser(`refund-progress-${stamp}@syntholo.test`);
    const membership = await withSystemScope((sql) => ensureAccountForUser(userId, {}, sql));
    const [lesson] = await db`SELECT id FROM lessons LIMIT 1`;
    const purchaseId = await withSystemScope(async (sql) => {
      const [purchase] = await sql`
        INSERT INTO purchases (account_id, user_id, email, offer, kind, status, stripe_session_id)
        VALUES (
          ${membership.accountId},
          ${userId},
          ${`refund-progress-${stamp}@syntholo.test`},
          ${"self-paced"},
          ${"payment"},
          ${"paid"},
          ${`cs_refund_progress_${stamp}`}
        )
        RETURNING id
      `;
      await upsertEntitlementGrant(
        {
          accountId: membership.accountId,
          userId,
          capability: "academy_course",
          source: "purchase",
          sourceId: String(purchase.id),
        },
        sql,
      );
      await sql`
        INSERT INTO enrollments (account_id, user_id, course_id, source_purchase_id)
        VALUES (${membership.accountId}, ${userId}, ${academyCourse.id}, ${purchase.id})
        ON CONFLICT (user_id, course_id) DO NOTHING
      `;
      await sql`
        INSERT INTO lesson_progress (account_id, user_id, lesson_id, status, completed_at)
        VALUES (${membership.accountId}, ${userId}, ${lesson.id}, ${"completed"}, now())
        ON CONFLICT (user_id, lesson_id) DO UPDATE SET status = 'completed'
      `;
      return String(purchase.id);
    });

    expect((await loadEffectiveAccess(membership.accountId)).capabilities.academy_course).toBe(true);
    const refund = await applyPurchaseRefund(purchaseId);
    expect(refund?.changed).toBe(true);
    expect((await loadEffectiveAccess(membership.accountId)).capabilities.academy_course).toBe(false);

    const progress = await withSystemScope(
      (sql) => sql`SELECT status FROM lesson_progress WHERE user_id = ${userId} AND lesson_id = ${lesson.id}`,
    );
    expect(progress).toHaveLength(1);
    expect(progress[0].status).toBe("completed");
  });

  it("does not let a commerce hold turn off academy_course", async () => {
    const { ensureAccountForUser, loadEffectiveAccess, setAccountHold, upsertEntitlementGrant, withSystemScope } =
      await import("./index");
    const userId = await createUser(`hold-academy-${Date.now()}@syntholo.test`);
    const membership = await withSystemScope((sql) => ensureAccountForUser(userId, {}, sql));
    await withSystemScope(async (sql) => {
      await upsertEntitlementGrant(
        { accountId: membership.accountId, userId, capability: "academy_course", source: "admin" },
        sql,
      );
      await setAccountHold({ accountId: membership.accountId, kind: "commerce", reason: "open_dispute" }, sql);
    });
    const access = await loadEffectiveAccess(membership.accountId);
    expect(access.capabilities.academy_course).toBe(true);
    expect(access.holds).toContain("commerce");
  });

  it("blocks seat invites while a seat_changes hold is active", async () => {
    const { ensureAccountForUser, inviteTeammate, setAccountHold, withSystemScope } = await import("./index");
    const userId = await createUser(`hold-seats-${Date.now()}@syntholo.test`);
    const membership = await withSystemScope((sql) => ensureAccountForUser(userId, {}, sql));
    await withSystemScope((sql) =>
      setAccountHold({ accountId: membership.accountId, kind: "seat_changes", reason: "open_dispute" }, sql),
    );
    await expect(
      inviteTeammate({
        accountId: membership.accountId,
        email: `held-invite-${Date.now()}@syntholo.test`,
        invitedBy: userId,
      }),
    ).rejects.toThrow(/seat changes/i);
  });

  it("blocks Business OS activation without a business_os grant", async () => {
    const { ensureAccountForUser, ensureStudentWorkspace, submitSoftwareProvisioning, upsertEntitlementGrant, withSystemScope } =
      await import("./index");
    const userId = await createUser(`os-locked-${Date.now()}@syntholo.test`);
    await withSystemScope((sql) => ensureAccountForUser(userId, {}, sql));
    await withSystemScope(async (sql) => {
      await upsertEntitlementGrant(
        {
          accountId: (await ensureAccountForUser(userId, {}, sql)).accountId,
          userId,
          capability: "academy_course",
          source: "admin",
        },
        sql,
      );
    });
    await ensureStudentWorkspace({ userId, displayName: "OS Locked" });
    await expect(submitSoftwareProvisioning(userId)).rejects.toThrow(/business os/i);
  });

  it("rejects an inverted grant interval", async () => {
    const { ensureAccountForUser, withSystemScope } = await import("./index");
    const userId = await createUser(`grant-interval-${Date.now()}@syntholo.test`);
    const membership = await withSystemScope((sql) => ensureAccountForUser(userId, {}, sql));
    try {
      await withSystemScope(
        (sql) => sql`
          INSERT INTO entitlement_grants (account_id, user_id, capability, status, source, starts_at, ends_at)
          VALUES (
            ${membership.accountId},
            ${userId},
            ${"academy_course"},
            ${"active"},
            ${"admin"},
            ${"2026-08-24T00:00:00.000Z"},
            ${"2026-08-01T00:00:00.000Z"}
          )
        `,
      );
      throw new Error("expected inverted grant interval to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "23514" });
    }
  });

  it("staff grant and revoke go through the evaluator", async () => {
    const { ensureAccountForUser, grantCourseEntitlement, revokeCourseEntitlement, withSystemScope } =
      await import("./index");
    const userId = await createUser(`staff-grant-${Date.now()}@syntholo.test`);
    await withSystemScope((sql) => ensureAccountForUser(userId, {}, sql));
    const granted = await grantCourseEntitlement(userId, academyCourse.id);
    expect(granted.capabilities.academy_course).toBe(true);
    const revoked = await revokeCourseEntitlement(userId, academyCourse.id);
    expect(revoked.capabilities.academy_course).toBe(false);
  });
});
