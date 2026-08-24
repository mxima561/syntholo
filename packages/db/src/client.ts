import postgres from "postgres";
import { academyCourse } from "@syntholo/domain/course";
import { COURSE_TEMPLATES, upcomingOfficeHours } from "./catalog";
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
  `CREATE TABLE IF NOT EXISTS entitlement_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (capability IN ('academy_course', 'support', 'circle_write', 'operator_club', 'business_os')),
    status TEXT NOT NULL CHECK (status IN ('active', 'grace', 'expired', 'refunded', 'revoked')),
    source TEXT NOT NULL CHECK (source IN ('purchase', 'admin', 'demo')),
    source_id TEXT,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS entitlement_grants_user_idx ON entitlement_grants (user_id, capability, status)`,
  `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS public_id TEXT`,
  `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS business_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS job_title TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York'`,
  `UPDATE app_users SET public_id = 'STU-' || upper(substr(replace(id::text, '-', ''), 1, 8)) WHERE public_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS app_users_public_id_uidx ON app_users (public_id)`,
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS public_id TEXT`,
  `UPDATE staff SET public_id = 'STF-' || upper(substr(replace(id::text, '-', ''), 1, 8)) WHERE public_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS staff_public_id_uidx ON staff (public_id)`,
  `CREATE TABLE IF NOT EXISTS activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('student', 'staff', 'system')),
    actor_id TEXT,
    actor_label TEXT NOT NULL DEFAULT '',
    actor_public_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS activity_events_created_idx ON activity_events (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS activity_events_actor_idx ON activity_events (actor_id)`,
  `CREATE INDEX IF NOT EXISTS activity_events_action_idx ON activity_events (action)`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'draft', 'final')),
    version INTEGER NOT NULL DEFAULT 1,
    body TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none', 'requested', 'feedback_ready')),
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    engine TEXT NOT NULL CHECK (engine IN ('growth', 'client', 'management')),
    problem TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    approved_tools TEXT[] NOT NULL DEFAULT '{}',
    steps TEXT[] NOT NULL DEFAULT '{}',
    human_review_point TEXT NOT NULL DEFAULT '',
    safety_notes TEXT NOT NULL DEFAULT '',
    baseline TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'testing', 'live', 'paused')),
    launch_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS live_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT 'Americas',
    host_name TEXT NOT NULL DEFAULT 'Naomi Reed',
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'completed', 'canceled')),
    capacity INTEGER NOT NULL DEFAULT 40,
    join_url TEXT,
    recording_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS session_rsvps (
    session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS course_templates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'text/markdown',
    body TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS community_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    author_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    initials TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS community_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    reporter_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL DEFAULT 'inappropriate',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS scorecard_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    email CITEXT,
    first_name TEXT NOT NULL DEFAULT '',
    business_name TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    overall_score INTEGER NOT NULL,
    band TEXT NOT NULL,
    answers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS software_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending_onboarding' CHECK (status IN ('pending_onboarding', 'provisioning', 'active', 'paused', 'canceled')),
    checklist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes TEXT NOT NULL DEFAULT '',
    checks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    provisioning_started_at TIMESTAMPTZ,
    provisioning_due_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL REFERENCES courses(id),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, course_id)
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

async function seedSchoolCatalog(db: DatabaseClient) {
  const [sessions] = await db`SELECT COUNT(*)::int AS count FROM live_sessions`;
  if (sessions.count === 0) {
    for (const session of upcomingOfficeHours()) {
      await db`
        INSERT INTO live_sessions (title, description, region, host_name, starts_at, ends_at, status, capacity)
        VALUES (
          ${session.title}, ${session.description}, ${session.region}, ${session.hostName},
          ${session.startsAt}, ${session.endsAt}, 'scheduled', 100
        )
      `;
    }
  }
  for (const template of COURSE_TEMPLATES) {
    await db`
      INSERT INTO course_templates (id, title, description, filename, body)
      VALUES (${template.id}, ${template.title}, ${template.description}, ${template.filename}, ${template.body})
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

let readyPromise: Promise<void> | undefined;

export async function getReadyDb(): Promise<DatabaseClient> {
  const db = getDb();
  readyPromise ??= (async () => {
    await db`SET client_min_messages TO warning`;
    for (const statement of schemaStatements) {
      await db.unsafe(statement);
    }
    await seedCurriculum(db);
    await seedSchoolCatalog(db);
    const { bootstrapAccountModel } = await import("./accounts");
    await bootstrapAccountModel(db);
  })().catch((error) => {
    readyPromise = undefined;
    throw error;
  });
  await readyPromise;
  return db;
}
