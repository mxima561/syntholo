import postgres from "postgres";
import { academyCourse } from "@/lib/domain/course";

export type DatabaseClient = ReturnType<typeof createPostgresClient>;

let client: DatabaseClient | undefined;

function getDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : undefined;
}

function createPostgresClient() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured. Add your Neon Postgres connection string to .env.");
  }
  return postgres(databaseUrl, { max: 5, idle_timeout: 20, connect_timeout: 15 });
}

export function getDb(): DatabaseClient {
  client ??= createPostgresClient();
  return client;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workos_id TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'student')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS course_stages (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    short_title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    release_week INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    stage_id TEXT NOT NULL REFERENCES course_stages(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    action_label TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL DEFAULT 10,
    resource_count INTEGER NOT NULL DEFAULT 1,
    required BOOLEAN NOT NULL DEFAULT TRUE,
    video_url TEXT,
    transcript TEXT NOT NULL DEFAULT '',
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS enrollments (
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, course_id)
  )`,
  `CREATE TABLE IF NOT EXISTS lesson_progress (
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, lesson_id)
  )`,
  `CREATE INDEX IF NOT EXISTS lessons_course_idx ON lessons (course_id)`,
  `CREATE INDEX IF NOT EXISTS lesson_progress_user_idx ON lesson_progress (user_id)`,
];

async function seedCurriculum(db: DatabaseClient) {
  const [existing] = await db`SELECT COUNT(*)::int AS count FROM courses`;
  if (existing.count > 0) return;

  await db`
    INSERT INTO courses (id, title, description, status)
    VALUES (${academyCourse.id}, ${academyCourse.title}, ${academyCourse.description}, 'published')
    ON CONFLICT (id) DO NOTHING
  `;
  for (const stage of academyCourse.stages) {
    await db`
      INSERT INTO course_stages (id, course_id, number, title, short_title, description, release_week)
      VALUES (${stage.id}, ${academyCourse.id}, ${stage.number}, ${stage.title}, ${stage.shortTitle}, ${stage.description}, ${stage.releaseWeek})
      ON CONFLICT (id) DO NOTHING
    `;
    for (const lesson of stage.lessons) {
      await db`
        INSERT INTO lessons (id, stage_id, course_id, number, title, summary, action_label, duration_minutes, resource_count, transcript, is_published)
        VALUES (
          ${lesson.id}, ${stage.id}, ${academyCourse.id}, ${lesson.number}, ${lesson.title},
          ${lesson.summary}, ${lesson.actionLabel}, ${lesson.durationMinutes}, ${lesson.resourceCount},
          ${lesson.transcript.join("\n\n")}, TRUE
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }
}

let readyPromise: Promise<void> | undefined;

export async function getReadyDb(): Promise<DatabaseClient> {
  const db = getDb();
  readyPromise ??= (async () => {
    for (const statement of schemaStatements) {
      await db.unsafe(statement);
    }
    await seedCurriculum(db);
  })().catch((error) => {
    readyPromise = undefined;
    throw error;
  });
  await readyPromise;
  return db;
}
