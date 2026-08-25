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

describe.skipIf(!canReachScratchDatabase)("account seats and RLS", () => {
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
      VALUES (${email}, ${"Seat"}, ${"Tester"}, ${"student"})
      ON CONFLICT (email) DO UPDATE SET first_name = EXCLUDED.first_name
      RETURNING id
    `;
    return String(row.id);
  }

  it("rejects a fourth academy seat", async () => {
    const { ensureAccountForUser, inviteTeammate, withSystemScope } = await import("./index");
    const ownerId = await createUser(`seats-owner-${Date.now()}@syntholo.test`);
    const membership = await withSystemScope((db) => ensureAccountForUser(ownerId, {}, db));
    await inviteTeammate({
      accountId: membership.accountId,
      email: `seat-two-${Date.now()}@syntholo.test`,
      invitedBy: ownerId,
    });
    await inviteTeammate({
      accountId: membership.accountId,
      email: `seat-three-${Date.now()}@syntholo.test`,
      invitedBy: ownerId,
    });
    await expect(
      inviteTeammate({
        accountId: membership.accountId,
        email: `seat-four-${Date.now()}@syntholo.test`,
        invitedBy: ownerId,
      }),
    ).rejects.toThrow(/three seats/i);
  });

  it("hides another account's artifacts under member scope", async () => {
    const { ensureStudentWorkspace, listArtifacts, withAccountScope, withSystemScope, ensureAccountForUser } =
      await import("./index");
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();

    const userA = await createUser(`rls-a-${Date.now()}@syntholo.test`);
    const userB = await createUser(`rls-b-${Date.now()}@syntholo.test`);
    const membershipA = await withSystemScope((sql) => ensureAccountForUser(userA, {}, sql));
    const membershipB = await withSystemScope((sql) => ensureAccountForUser(userB, {}, sql));
    await ensureStudentWorkspace({ userId: userA, displayName: "A" });
    await ensureStudentWorkspace({ userId: userB, displayName: "B" });

    const artifactsA = await listArtifacts(userA);
    const artifactsB = await listArtifacts(userB);
    expect(artifactsA.length).toBeGreaterThan(0);
    expect(artifactsB.length).toBeGreaterThan(0);
    expect(artifactsA.every((row) => artifactsB.every((other) => other.id !== row.id))).toBe(true);

    const leakedCross = await withAccountScope(membershipA.accountId, (sql) => sql`
      SELECT id FROM artifacts WHERE account_id = ${membershipB.accountId}
    `);
    const [role] = await db`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (!role.bypass) {
      expect(leakedCross).toHaveLength(0);
    }
  });
});
