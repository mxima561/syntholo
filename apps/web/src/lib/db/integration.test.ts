import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "@/lib/db/client";

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

let db: DatabaseClient;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const { getReadyDb } = await import("@/lib/db/client");
  db = await getReadyDb();
});

afterAll(async () => {
  if (!db) return;
  await db.unsafe("DROP SCHEMA public CASCADE").catch(() => undefined);
  await db.unsafe("CREATE SCHEMA public").catch(() => undefined);
  await db.end().catch(() => undefined);
});

async function createTestUser(email: string, firstName: string, role = "student") {
  const [row] = await db`
    INSERT INTO app_users (email, first_name, last_name, role)
    VALUES (${email}, ${firstName}, ${"Tester"}, ${role})
    ON CONFLICT (email) DO UPDATE SET first_name = EXCLUDED.first_name
    RETURNING id
  `;
  return row.id as string;
}

describe.skipIf(!canReachScratchDatabase)("database layer (integration)", () => {
  it("bootstraps schema and seeds the full curriculum", async () => {
    const [course] = await db`SELECT * FROM courses`;
    expect(course.title).toBe("AI Operating System Academy");
    expect(course.status).toBe("published");

    const [lessonCount] = await db`SELECT COUNT(*)::int AS count FROM lessons`;
    expect(lessonCount.count).toBe(18);

    const [stageCount] = await db`SELECT COUNT(*)::int AS count FROM course_stages`;
    expect(stageCount.count).toBe(6);
  });

  it("serves the student course map with progress tracking", async () => {
    const coursesModule = await import("@/lib/server/courses");
    const course = await coursesModule.getPrimaryCourse();
    expect(course?.stages.length).toBe(6);
    expect(course?.stages[0].lessons.length).toBe(3);

    const userId = await createTestUser("map-test@syntholo.test", "Map");
    await coursesModule.ensureEnrollment(userId, course!.id);
    await coursesModule.setLessonProgress(userId, "diagnose-1", true);

    const completed = await coursesModule.getCompletedLessonIds(userId);
    expect(completed).toEqual(["diagnose-1"]);

    // Un-marking clears completion
    await coursesModule.setLessonProgress(userId, "diagnose-1", false);
    expect(await coursesModule.getCompletedLessonIds(userId)).toEqual([]);
  });

  it("hides draft lessons from students but shows them to admins", async () => {
    const coursesModule = await import("@/lib/server/courses");
    await db`
      INSERT INTO lessons (id, stage_id, course_id, number, title, is_published)
      VALUES ('draft-check', 'diagnose', 'ai-operating-system-academy', 99, 'Draft lesson', FALSE)
      ON CONFLICT (id) DO NOTHING
    `;
    const studentView = await coursesModule.getPrimaryCourse();
    expect(studentView!.stages.flatMap((s) => s.lessons.map((l) => l.id))).not.toContain("draft-check");
    const adminView = await coursesModule.getPrimaryCourse(true);
    expect(adminView!.stages.flatMap((s) => s.lessons.map((l) => l.id))).toContain("draft-check");
    const studentLesson = await coursesModule.getLessonById("draft-check");
    expect(studentLesson).toBeNull();
    const adminLesson = await coursesModule.getLessonById("draft-check", true);
    expect(adminLesson?.title).toBe("Draft lesson");
  });

  it("supports the admin lesson CRUD lifecycle", async () => {
    const coursesModule = await import("@/lib/server/courses");
    const lessonId = await coursesModule.createLesson({
      courseId: "ai-operating-system-academy",
      stageId: "growth",
      title: "Integration Test Lesson",
    });
    expect(lessonId).toContain("integration-test-lesson");

    await coursesModule.updateLesson(lessonId, {
      title: "Renamed Lesson",
      summary: "Updated summary",
      actionLabel: "Do the thing",
      durationMinutes: 15,
      resourceCount: 2,
      videoUrl: "https://youtu.be/abc123",
      transcript: ["Para one", "", "Para two"],
      isPublished: true,
    });

    const lesson = await coursesModule.getLessonById(lessonId, true);
    expect(lesson?.title).toBe("Renamed Lesson");
    expect(lesson?.videoUrl).toBe("https://youtu.be/abc123");
    expect(lesson?.transcript).toEqual(["Para one", "Para two"]);
    expect(lesson?.isPublished).toBe(true);
    expect(await coursesModule.getNextPublishedLesson(9)).not.toBeNull();

    await coursesModule.deleteLesson(lessonId);
    expect(await coursesModule.getLessonById(lessonId, true)).toBeNull();
  });

  it("reports overview stats and per-student progress", async () => {
    const coursesModule = await import("@/lib/server/courses");
    const userId = await createTestUser("stats-test@syntholo.test", "Stats");
    await coursesModule.setLessonProgress(userId, "rules-1", true);
    await coursesModule.setLessonProgress(userId, "rules-2", true);

    await createTestUser("admin-overview-test@syntholo.test", "Boss");
    await db`UPDATE app_users SET role = 'student' WHERE email LIKE '%overview-test%'`;

    const students = await coursesModule.listStudents();
    const statsStudent = students.find((student) => student.email === "stats-test@syntholo.test");
    expect(statsStudent?.completedLessons).toBe(2);

    const overview = await coursesModule.getAdminOverview();
    expect(overview.totalLessons).toBeGreaterThanOrEqual(18);
    expect(overview.publishedLessons).toBeGreaterThan(0);
    expect(overview.completions).toBeGreaterThanOrEqual(2);
    expect(overview.stageCompletion.length).toBe(6);

    await coursesModule.setUserRole(userId, "student");
    const unchanged = (await coursesModule.listStudents()).find(
      (student) => student.email === "stats-test@syntholo.test",
    );
    expect(unchanged?.role).toBe("student");
  });

  it("fulfills a checkout exactly once and grants course access", async () => {
    const purchases = await import("@/lib/server/purchases");
    const userId = await createTestUser("buyer-test@syntholo.test", "Buyer");

    const first = await purchases.fulfillCheckout({
      sessionId: "cs_test_123",
      email: "buyer-test@syntholo.test",
      offer: "self-paced",
      kind: "payment",
      customerId: "cus_test_1",
      userId,
    });
    expect(first.created).toBe(true);

    // Replay (webhook + success page double-fire) must be a no-op.
    const replay = await purchases.fulfillCheckout({
      sessionId: "cs_test_123",
      email: "buyer-test@syntholo.test",
      offer: "self-paced",
      kind: "payment",
      userId,
    });
    expect(replay.created).toBe(false);

    const { withSystemScope } = await import("@syntholo/db");
    const [enrollmentCount] = await withSystemScope(
      (sql) => sql`
        SELECT COUNT(*)::int AS count FROM enrollments
        WHERE user_id = ${userId} AND course_id = 'ai-operating-system-academy'
      `,
    );
    expect(enrollmentCount.count).toBe(1);

    const history = await purchases.getPurchasesForUser(userId);
    expect(history).toHaveLength(1);
    expect(history[0].offer).toBe("self-paced");
    expect(history[0].status).toBe("paid");
  });

  it("cancels a subscription purchase and revokes only its enrollment", async () => {
    const purchases = await import("@/lib/server/purchases");
    const userId = await createTestUser("subscriber-test@syntholo.test", "Sub");

    await purchases.fulfillCheckout({
      sessionId: "cs_test_sub",
      email: "subscriber-test@syntholo.test",
      offer: "operator-club",
      kind: "subscription",
      subscriptionId: "sub_test_1",
      userId,
    });

    const revoked = await purchases.revokeSubscription({ subscriptionId: "sub_test_1" });
    expect(revoked).toBe(true);

    const history = await purchases.getPurchasesForUser(userId);
    expect(history[0].status).toBe("canceled");

    const { withSystemScope } = await import("@syntholo/db");
    const [remaining] = await withSystemScope(
      (sql) => sql`
        SELECT COUNT(*)::int AS count FROM enrollments WHERE user_id = ${userId} AND source_purchase_id IS NOT NULL
      `,
    );
    expect(remaining.count).toBe(0);
  });

  it("persists community posts and per-user reactions", async () => {
    const community = await import("@/lib/server/community");
    const authorId = await createTestUser("poster-test@syntholo.test", "Poster");

    const postId = await community.createCommunityPost({
      authorId,
      authorName: "Poster Tester",
      authorBusiness: "Test Co",
      initials: "PT",
      space: "Growth Engine",
      title: "Lead routing is live",
      body: "Sharing our first launch notes.",
    });

    const viewerId = await createTestUser("reader-test@syntholo.test", "Reader");
    let posts = await community.listCommunityPosts(viewerId);
    expect(posts.find((post) => post.id === postId)?.reactionCount).toBe(0);

    const liked = await community.toggleCommunityReaction(postId, viewerId);
    expect(liked.liked).toBe(true);
    expect(liked.reactionCount).toBe(1);

    const unliked = await community.toggleCommunityReaction(postId, viewerId);
    expect(unliked.liked).toBe(false);
    expect(unliked.reactionCount).toBe(0);

    posts = await community.listCommunityPosts(viewerId);
    expect(posts.find((post) => post.id === postId)?.authorBusiness).toBe("Test Co");
  });

  it("runs the full support loop: welcome thread, replies, coach response", async () => {
    const support = await import("@/lib/server/support");
    const userId = await createTestUser("supporter-test@syntholo.test", "Support");

    await support.ensureWelcomeThread(userId, "Support");
    await support.ensureWelcomeThread(userId, "Support"); // idempotent

    const threads = await support.listThreadsForUser(userId);
    expect(threads).toHaveLength(1);
    expect(threads[0].coachName).toBe("Naomi Reed");
    expect(await support.getThreadMessages(threads[0].id)).toHaveLength(1);

    await support.createSupportThread({
      userId,
      subject: "Review my AI policy draft",
      firstMessage: "Attached is our one-page policy.",
      authorName: "Support Tester",
    });

    const reopened = await support.listThreadsForUser(userId);
    expect(reopened).toHaveLength(2);

    await support.addCustomerReply({
      threadId: reopened[0].id,
      userId,
      authorName: "Support Tester",
      body: "Following up on this.",
    });
    let messages = await support.getThreadMessages(reopened[0].id);
    expect(messages.at(-1)?.authorRole).toBe("customer");

    await support.addCoachReply({
      threadId: reopened[0].id,
      coachName: "Naomi Reed",
      body: "Great question — here is my feedback.",
    });
    messages = await support.getThreadMessages(reopened[0].id);
    expect(messages.at(-1)?.authorRole).toBe("coach");

    const adminView = await support.listAllThreads();
    expect(adminView.length).toBeGreaterThanOrEqual(2);
    expect(adminView[0].messageCount).toBeGreaterThanOrEqual(3);
  });
});
