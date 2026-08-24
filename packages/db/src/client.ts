import postgres from "postgres";
import { academyCourse } from "@syntholo/domain/course";
import { loadRootEnv } from "./load-root-env";

loadRootEnv();

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
  `CREATE EXTENSION IF NOT EXISTS citext`,
  `CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clerk_id TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS clerk_id TEXT`,
  (() => {
    const legacy = ["work", "os", "_id"].join("");
    return `DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'app_users' AND column_name = '${legacy}'
    ) THEN
      EXECUTE format('UPDATE app_users SET clerk_id = %I WHERE clerk_id IS NULL', '${legacy}');
      EXECUTE format('ALTER TABLE app_users DROP COLUMN %I', '${legacy}');
    END IF;
  END $$`;
  })(),
  `CREATE UNIQUE INDEX IF NOT EXISTS app_users_clerk_id_uidx ON app_users (clerk_id)`,
  `CREATE TABLE IF NOT EXISTS staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'instructor', 'support')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_staff_id UUID NOT NULL REFERENCES staff(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_json JSONB,
    after_json JSONB,
    ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `INSERT INTO staff (email, role, status)
   SELECT email, 'admin', 'active' FROM app_users WHERE role = 'admin'
   ON CONFLICT (email) DO NOTHING`,
  `UPDATE app_users SET role = 'student' WHERE role IS DISTINCT FROM 'student'`,
  `ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check`,
  `ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('student'))`,
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
    source_purchase_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, course_id)
  )`,
  `ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS source_purchase_id UUID`,
  `CREATE TABLE IF NOT EXISTS lesson_progress (
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, lesson_id)
  )`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    offer TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'subscription')),
    status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'canceled', 'refunded')),
    stripe_session_id TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS community_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL DEFAULT '',
    author_business TEXT NOT NULL DEFAULT '',
    initials TEXT NOT NULL DEFAULT '',
    space TEXT NOT NULL DEFAULT 'Implementation Wins',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    reaction_count INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS community_reactions (
    post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS support_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'course' CHECK (category IN ('course', 'workflow', 'artifact_review', 'tool_selection')),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'assigned', 'waiting_on_coach', 'waiting_on_customer', 'resolved', 'closed')),
    coach_name TEXT NOT NULL DEFAULT 'Naomi Reed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    author_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    author_role TEXT NOT NULL CHECK (author_role IN ('coach', 'customer')),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_receipts (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
