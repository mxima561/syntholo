import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

describe.skipIf(!canReachScratchDatabase)("staff identity matching", () => {
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

  it("matches active staff by email, neon user id, or platform_admins.user_id", async () => {
    const { insertStaff, isActiveStaffIdentity, updateStaffStatus, withSystemScope } = await import("./index");
    const stamp = Date.now();
    const email = `Staff.Identity+${stamp}@syntholo.test`;
    const neonId = `neon_staff_${stamp}`;
    const platformNeonId = `neon_platform_${stamp}`;
    const staff = await insertStaff({ email, role: "super_admin" });

    expect(await isActiveStaffIdentity({ email, neonUserId: null })).toBe(true);
    expect(await isActiveStaffIdentity({ email: email.toUpperCase(), neonUserId: null })).toBe(true);
    expect(await isActiveStaffIdentity({ email: `other-${stamp}@syntholo.test`, neonUserId: null })).toBe(false);

    await withSystemScope(async (db) => {
      await db`UPDATE staff SET neon_user_id = ${neonId} WHERE id = ${staff.id}`;
    });
    expect(await isActiveStaffIdentity({ email: `other-${stamp}@syntholo.test`, neonUserId: neonId })).toBe(true);

    const linked = await insertStaff({ email: `linked-${stamp}@syntholo.test`, role: "admin" });
    await withSystemScope(async (db) => {
      await db`UPDATE platform_admins SET user_id = ${platformNeonId} WHERE staff_id = ${linked.id}`;
    });
    expect(
      await isActiveStaffIdentity({ email: `nobody-${stamp}@syntholo.test`, neonUserId: platformNeonId }),
    ).toBe(true);

    await updateStaffStatus(linked.id, "suspended");
    expect(
      await isActiveStaffIdentity({ email: `nobody-${stamp}@syntholo.test`, neonUserId: platformNeonId }),
    ).toBe(false);
  });
});
