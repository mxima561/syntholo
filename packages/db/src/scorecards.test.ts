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

describe.skipIf(!canReachScratchDatabase)("scorecard leads", () => {
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

  it("creates no commercial access from a Scorecard", async () => {
    const { persistScorecardLead, getPublicScorecardReport, getReadyDb } = await import("./index");
    const db = await getReadyDb();
    const marker = `scorecard-${Date.now()}@example.com`;
    const saved = await persistScorecardLead({
      email: marker,
      firstName: "Maria",
      businessName: "Northstar",
      country: "United States",
      overallScore: 62,
      band: "Building",
      answers: { q1: 3 },
      marketingConsent: false,
    });

    const [purchases] = await db`SELECT COUNT(*)::int AS count FROM purchases WHERE email = ${marker}`;
    const [grants] = await db`SELECT COUNT(*)::int AS count FROM entitlement_grants WHERE user_id IN (SELECT id FROM app_users WHERE email = ${marker})`;
    const [seats] = await db`SELECT COUNT(*)::int AS count FROM invitations WHERE email = ${marker}`;
    const [enrollments] = await db`SELECT COUNT(*)::int AS count FROM enrollments WHERE user_id IN (SELECT id FROM app_users WHERE email = ${marker})`;
    expect([purchases.count, grants.count, seats.count, enrollments.count]).toEqual([0, 0, 0, 0]);

    const report = await getPublicScorecardReport(saved.reportToken);
    expect(report).toMatchObject({ overallScore: 62, band: "Building" });
    expect(JSON.stringify(report)).not.toMatch(/@example.com|Maria|Northstar/i);
  });
});
