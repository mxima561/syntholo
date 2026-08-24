export type AccountRole = "student";

export type DbStage = {
  id: string;
  number: number;
  title: string;
  shortTitle: string;
  description: string;
  releaseWeek: number;
};

export type DbLesson = {
  id: string;
  stageId: string;
  number: number;
  title: string;
  summary: string;
  actionLabel: string;
  durationMinutes: number;
  resourceCount: number;
  required: boolean;
  videoUrl: string | null;
  transcript: string[];
  isPublished: boolean;
};

export type DbCourse = {
  id: string;
  title: string;
  description: string;
  status: "draft" | "published";
  updatedAt: Date;
};

type LessonRow = {
  id: string;
  stage_id: string;
  course_id: string;
  number: number;
  title: string;
  summary: string;
  action_label: string;
  duration_minutes: number;
  resource_count: number;
  required: boolean;
  video_url: string | null;
  transcript: string;
  is_published: boolean;
};

function toDbLesson(row: LessonRow): DbLesson {
  return {
    id: row.id,
    stageId: row.stage_id,
    number: row.number,
    title: row.title,
    summary: row.summary,
    actionLabel: row.action_label,
    durationMinutes: row.duration_minutes,
    resourceCount: row.resource_count,
    required: row.required,
    videoUrl: row.video_url,
    transcript: row.transcript.split("\n\n").filter(Boolean),
    isPublished: row.is_published,
  };
}

export type PrimaryCourse = {
  id: string;
  title: string;
  description: string;
  status: "draft" | "published";
  updatedAt: Date;
  stages: Array<DbStage & { lessons: DbLesson[] }>;
};

export async function getPrimaryCourse(includeDrafts = false): Promise<PrimaryCourse | null> {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  const [course] = includeDrafts
    ? await db`SELECT * FROM courses ORDER BY created_at LIMIT 1`
    : await db`SELECT * FROM courses WHERE status = 'published' ORDER BY created_at LIMIT 1`;
  if (!course) return null;

  const stages = await db`
    SELECT id, number, title, short_title AS "shortTitle", description, release_week AS "releaseWeek"
    FROM course_stages WHERE course_id = ${course.id} ORDER BY number
  `;
  const lessonRows =
    includeDrafts
      ? await db`SELECT * FROM lessons WHERE course_id = ${course.id} ORDER BY stage_id, number, title`
      : await db`SELECT * FROM lessons WHERE course_id = ${course.id} AND is_published ORDER BY stage_id, number, title`;

  return {
    id: String(course.id),
    title: String(course.title),
    description: String(course.description),
    status: course.status === "published" ? "published" : "draft",
    updatedAt: new Date(course.updated_at as string),
    stages: stages.map((stage) => ({
      id: String(stage.id),
      number: Number(stage.number),
      title: String(stage.title),
      shortTitle: String(stage.shortTitle),
      description: String(stage.description),
      releaseWeek: Number(stage.releaseWeek),
      lessons: lessonRows
        .filter((lesson) => lesson.stage_id === stage.id)
        .map((row) => toDbLesson(row as LessonRow)),
    })),
  };
}

export async function getCompletedLessonIds(userId: string): Promise<string[]> {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  const rows = await db`
    SELECT lesson_id FROM lesson_progress WHERE user_id = ${userId} AND status = 'completed'
  `;
  return rows.map((row) => row.lesson_id);
}

export async function getInProgressLessonId(userId: string): Promise<string | null> {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  const [row] = await db`
    SELECT lesson_id FROM lesson_progress
    WHERE user_id = ${userId} AND status = 'in_progress'
    ORDER BY updated_at DESC LIMIT 1
  `;
  return row?.lesson_id ?? null;
}

export async function setLessonProgress(userId: string, lessonId: string, complete: boolean) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  if (complete) {
    await db`
      INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at)
      VALUES (${userId}, ${lessonId}, 'completed', now())
      ON CONFLICT (user_id, lesson_id) DO UPDATE SET status = 'completed', completed_at = now(), updated_at = now()
    `;
  } else {
    await db`
      INSERT INTO lesson_progress (user_id, lesson_id, status)
      VALUES (${userId}, ${lessonId}, 'not_started')
      ON CONFLICT (user_id, lesson_id) DO UPDATE SET status = 'not_started', completed_at = NULL, updated_at = now()
    `;
  }
}

export async function ensureEnrollment(userId: string, courseId: string) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  await db`
    INSERT INTO enrollments (user_id, course_id) VALUES (${userId}, ${courseId})
    ON CONFLICT (user_id, course_id) DO NOTHING
  `;
}

export async function getLessonById(lessonId: string, includeDrafts = false) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  const rows = includeDrafts
    ? await db`SELECT * FROM lessons WHERE id = ${lessonId}`
    : await db`SELECT * FROM lessons WHERE id = ${lessonId} AND is_published`;
  return rows[0] ? toDbLesson(rows[0] as LessonRow) : null;
}

export async function getNextPublishedLesson(afterNumber: number) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  const [row] = await db`
    SELECT * FROM lessons WHERE is_published AND number > ${afterNumber}
    ORDER BY number LIMIT 1
  `;
  return row ? toDbLesson(row as LessonRow) : null;
}

// ---------------------------------------------------------------------------
// Admin analytics
// ---------------------------------------------------------------------------

export type AdminOverview = {
  studentCount: number;
  adminCount: number;
  completions: number;
  activeLearners: number;
  totalLessons: number;
  publishedLessons: number;
  recentStudents: Array<{ id: string; email: string; firstName: string; lastName: string; role: AccountRole; createdAt: Date }>;
  recentCompletions: Array<{ lessonId: string; lessonTitle: string; email: string; firstName: string; lastName: string; completedAt: Date | null }>;
  stageCompletion: Array<{ stageTitle: string; lessonCount: number; completions: number }>;
};

export async function getAdminOverview(): Promise<AdminOverview> {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();

  const [studentCount] = await db`
    SELECT COUNT(*)::int AS count FROM app_users WHERE role = 'student'
  `;
  const [adminCount] = await db`
    SELECT COUNT(*)::int AS count FROM staff WHERE status = 'active'
  `;
  const [completion] = await db`
    SELECT COUNT(*)::int AS completions, COUNT(DISTINCT user_id)::int AS learners
    FROM lesson_progress WHERE status = 'completed'
  `;
  const [lessonCounts] = await db`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_published)::int AS published FROM lessons
  `;
  const recentStudentRows = await db`
    SELECT id, email, first_name AS "firstName", last_name AS "lastName", role, created_at AS "createdAt"
    FROM app_users ORDER BY created_at DESC LIMIT 5
  `;
  const recentCompletionRows = await db`
    SELECT lp.lesson_id AS "lessonId", l.title AS "lessonTitle", u.email, u.first_name AS "firstName", u.last_name AS "lastName", lp.completed_at AS "completedAt"
    FROM lesson_progress lp
    JOIN app_users u ON u.id = lp.user_id
    JOIN lessons l ON l.id = lp.lesson_id
    WHERE lp.status = 'completed'
    ORDER BY lp.completed_at DESC LIMIT 6
  `;
  const stageRows = await db`
    SELECT cs.title AS "stageTitle", COUNT(l.id)::int AS "lessonCount",
           COUNT(lp.*)::int AS completions
    FROM course_stages cs
    LEFT JOIN lessons l ON l.stage_id = cs.id AND l.is_published
    LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.status = 'completed'
    GROUP BY cs.number, cs.title ORDER BY cs.number
  `;

  return {
    studentCount: Number(studentCount.count),
    adminCount: Number(adminCount.count),
    completions: Number(completion.completions),
    activeLearners: Number(completion.learners),
    totalLessons: Number(lessonCounts.total),
    publishedLessons: Number(lessonCounts.published),
    recentStudents: recentStudentRows.map((row) => ({
      id: String(row.id),
      email: String(row.email),
      firstName: String(row.firstName ?? ""),
      lastName: String(row.lastName ?? ""),
      role: "student" as const,
      createdAt: new Date(row.createdAt as string),
    })),
    recentCompletions: recentCompletionRows.map((row) => ({
      lessonId: String(row.lessonId),
      lessonTitle: String(row.lessonTitle),
      email: String(row.email),
      firstName: String(row.firstName ?? ""),
      lastName: String(row.lastName ?? ""),
      completedAt: row.completedAt ? new Date(row.completedAt as string) : null,
    })),
    stageCompletion: stageRows.map((row) => ({
      stageTitle: String(row.stageTitle),
      lessonCount: Number(row.lessonCount),
      completions: Number(row.completions),
    })),
  };
}

export type StudentRecord = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: AccountRole;
  createdAt: Date;
  lastSeenAt: Date;
  completedLessons: number;
};

export async function listStudents(): Promise<StudentRecord[]> {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  const rows = await db`
    SELECT u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName", u.role, u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
      (SELECT COUNT(*)::int FROM lesson_progress lp WHERE lp.user_id = u.id AND lp.status = 'completed') AS "completedLessons"
    FROM app_users u ORDER BY u.created_at DESC
  `;
  return rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    firstName: String(row.firstName ?? ""),
    lastName: String(row.lastName ?? ""),
    role: "student" as const,
    createdAt: new Date(row.createdAt as string),
    lastSeenAt: new Date(row.lastSeenAt as string),
    completedLessons: Number(row.completedLessons),
  }));
}

export async function setUserRole(userId: string, role: AccountRole) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  await db`UPDATE app_users SET role = 'student' WHERE id = ${userId}`;
  void role;
}

// ---------------------------------------------------------------------------
// Admin lesson mutations
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function createLesson(input: {
  stageId: string;
  courseId: string;
  title: string;
}) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  const [stage] = await db`SELECT * FROM course_stages WHERE id = ${input.stageId}`;
  if (!stage) throw new Error("Stage not found");

  const siblings = await db`
    SELECT COALESCE(MAX(number), 0)::int AS max FROM lessons WHERE stage_id = ${input.stageId}
  `;
  const base = slugify(input.title) || "lesson";
  let id = base;
  let attempt = 1;
  while ((await db`SELECT 1 FROM lessons WHERE id = ${id}`).length > 0) {
    attempt += 1;
    id = `${base}-${attempt}`;
  }

  await db`
    INSERT INTO lessons (id, stage_id, course_id, number, title, is_published)
    VALUES (${id}, ${input.stageId}, ${input.courseId}, ${siblings[0].max + 1}, ${input.title}, FALSE)
  `;
  return id;
}

export type LessonInput = {
  title: string;
  summary: string;
  actionLabel: string;
  durationMinutes: number;
  resourceCount: number;
  videoUrl: string | null;
  transcript: string[];
  isPublished: boolean;
  stageId?: string;
};

export async function updateLesson(lessonId: string, input: LessonInput) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  await db`
    UPDATE lessons SET
      title = ${input.title},
      summary = ${input.summary},
      action_label = ${input.actionLabel},
      duration_minutes = ${input.durationMinutes},
      resource_count = ${input.resourceCount},
      video_url = ${input.videoUrl},
      transcript = ${input.transcript.join("\n\n")},
      is_published = ${input.isPublished},
      updated_at = now()
    WHERE id = ${lessonId}
  `;
  if (input.stageId) {
    await db`UPDATE lessons SET stage_id = ${input.stageId} WHERE id = ${lessonId}`;
  }
}

export async function deleteLesson(lessonId: string) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  await db`DELETE FROM lessons WHERE id = ${lessonId}`;
}

export async function setCourseStatus(courseId: string, status: "draft" | "published") {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  await db`UPDATE courses SET status = ${status}, updated_at = now() WHERE id = ${courseId}`;
}

export async function updateStage(stageId: string, input: { title: string; shortTitle: string; description: string }) {
  const { getReadyDb } = await import("@syntholo/db");
  const db = await getReadyDb();
  await db`
    UPDATE course_stages SET title = ${input.title}, short_title = ${input.shortTitle}, description = ${input.description}
    WHERE id = ${stageId}
  `;
}
