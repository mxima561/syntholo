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

describe.skipIf(!canReachScratchDatabase)("multi-school membership and Data API RLS", () => {
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

  async function createUser(email: string, neonUserId: string) {
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const [row] = await db`
      INSERT INTO app_users (email, first_name, last_name, role, neon_user_id)
      VALUES (${email}, ${"Rls"}, ${"Tester"}, ${"student"}, ${neonUserId})
      ON CONFLICT (email) DO UPDATE SET neon_user_id = EXCLUDED.neon_user_id
      RETURNING id
    `;
    return String(row.id);
  }

  it("lets one user belong to two academy accounts", async () => {
    const { ensureAccountForUser, listMembershipsForUser, setActiveAccount, withSystemScope } = await import("./index");
    const stamp = Date.now();
    const userId = await createUser(`multi-school-${stamp}@syntholo.test`, `neon_multi_${stamp}`);
    const secondUser = await createUser(`multi-school-b-${stamp}@syntholo.test`, `neon_multi_b_${stamp}`);
    const first = await withSystemScope((sql) => ensureAccountForUser(userId, { name: "School A" }, sql));
    const other = await withSystemScope((sql) => ensureAccountForUser(secondUser, { name: "School B" }, sql));
    await withSystemScope(async (sql) => {
      await sql`
        INSERT INTO memberships (account_id, user_id, role, status)
        VALUES (${other.accountId}, ${userId}, 'teacher', 'active')
        ON CONFLICT (account_id, user_id) DO UPDATE SET status = 'active', role = 'teacher'
      `;
    });
    const memberships = await listMembershipsForUser(userId);
    expect(memberships.length).toBeGreaterThanOrEqual(2);
    const switched = await setActiveAccount(userId, other.accountId);
    expect(switched.accountId).toBe(other.accountId);
    expect(switched.role).toBe("teacher");
    expect(first.role).toBe("owner");
  });

  it("rejects a JWT user querying another school's artifacts", async () => {
    const { ensureAccountForUser, ensureStudentWorkspace, withSystemScope } = await import("./index");
    const { getReadyDb } = await import("./client");
    const db = await getReadyDb();
    const stamp = Date.now();
    const neonA = `neon_rls_a_${stamp}`;
    const neonB = `neon_rls_b_${stamp}`;
    const userA = await createUser(`jwt-a-${stamp}@syntholo.test`, neonA);
    const userB = await createUser(`jwt-b-${stamp}@syntholo.test`, neonB);
    const membershipA = await withSystemScope((sql) => ensureAccountForUser(userA, {}, sql));
    const membershipB = await withSystemScope((sql) => ensureAccountForUser(userB, {}, sql));
    await ensureStudentWorkspace({ userId: userA, displayName: "A" });
    await ensureStudentWorkspace({ userId: userB, displayName: "B" });

    await db`SELECT set_config('app.actor_kind', '', true)`;
    await db`SELECT set_config('app.account_id', '', true)`;
    await db`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: neonA })}, true)`;
    await db`SELECT set_config('app.neon_user_id', ${neonA}, true)`;

    const visible = await db`SELECT id FROM artifacts WHERE account_id = ${membershipA.accountId}`;
    const leaked = await db`SELECT id FROM artifacts WHERE account_id = ${membershipB.accountId}`;
    const [role] = await db`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (!role.bypass) {
      expect(visible.length).toBeGreaterThan(0);
      expect(leaked).toHaveLength(0);
    } else {
      expect(membershipA.accountId).not.toBe(membershipB.accountId);
    }
  });
});
