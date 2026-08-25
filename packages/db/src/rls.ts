/**
 * Data API + server RLS helpers.
 *
 * Customer requests via the Neon Data API run as the `authenticated` role with a
 * Neon Auth JWT. `auth.user_id()` (or `request.jwt.claims`) is the Neon Auth id.
 * Privileged Next.js / worker connections keep using `app.actor_kind` + `app.account_id`.
 */
export const RLS_HELPER_SQL = [
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
       CREATE ROLE authenticated NOLOGIN;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anonymous') THEN
       CREATE ROLE anonymous NOLOGIN;
     END IF;
   END $$`,
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE OR REPLACE FUNCTION app.current_auth_user_id() RETURNS text
   LANGUAGE plpgsql
   STABLE
   SECURITY DEFINER
   SET search_path = public, pg_temp
   AS $$
   DECLARE
     jwt_sub text;
     claims text;
   BEGIN
     BEGIN
       jwt_sub := auth.user_id();
       IF jwt_sub IS NOT NULL AND btrim(jwt_sub) <> '' THEN
         RETURN jwt_sub;
       END IF;
     EXCEPTION
       WHEN undefined_function THEN NULL;
       WHEN SQLSTATE '3F000' THEN NULL;
     END;

     claims := current_setting('request.jwt.claims', true);
     IF claims IS NOT NULL AND claims <> '' THEN
       BEGIN
         jwt_sub := claims::jsonb ->> 'sub';
         IF jwt_sub IS NOT NULL AND btrim(jwt_sub) <> '' THEN
           RETURN jwt_sub;
         END IF;
       EXCEPTION WHEN others THEN
         NULL;
       END;
     END IF;

     RETURN NULLIF(current_setting('app.neon_user_id', true), '');
   END;
   $$`,
  `REVOKE ALL ON FUNCTION app.current_auth_user_id() FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION app.current_auth_user_id() TO PUBLIC`,
  `CREATE OR REPLACE FUNCTION app.is_privileged_actor() RETURNS boolean
   LANGUAGE sql
   STABLE
   AS $$
     SELECT COALESCE(current_setting('app.actor_kind', true), '') IN ('staff', 'system')
   $$`,
  `CREATE OR REPLACE FUNCTION app.current_app_user_id() RETURNS uuid
   LANGUAGE sql
   STABLE
   SECURITY DEFINER
   SET search_path = public
   AS $$
     SELECT id FROM app_users
     WHERE neon_user_id IS NOT NULL AND neon_user_id = app.current_auth_user_id()
     LIMIT 1
   $$`,
  `CREATE OR REPLACE FUNCTION app.member_account_ids() RETURNS SETOF uuid
   LANGUAGE sql
   STABLE
   SECURITY DEFINER
   SET search_path = public
   AS $$
     SELECT m.account_id
     FROM memberships m
     JOIN app_users u ON u.id = m.user_id
     WHERE m.status = 'active'
       AND u.neon_user_id IS NOT NULL
       AND u.neon_user_id = app.current_auth_user_id()
   $$`,
  `CREATE OR REPLACE FUNCTION app.is_account_member(target uuid) RETURNS boolean
   LANGUAGE sql
   STABLE
   SECURITY DEFINER
   SET search_path = public
   AS $$
     SELECT
       app.is_privileged_actor()
       OR (
         target IS NOT NULL AND (
           target::text = NULLIF(current_setting('app.account_id', true), '')
           OR EXISTS (
             SELECT 1
             FROM memberships m
             JOIN app_users u ON u.id = m.user_id
             WHERE m.account_id = target
               AND m.status = 'active'
               AND (
                 u.id = app.current_app_user_id()
                 OR (u.neon_user_id IS NOT NULL AND u.neon_user_id = app.current_auth_user_id())
               )
           )
         )
       )
   $$`,
  `CREATE OR REPLACE FUNCTION app.membership_role(target uuid) RETURNS text
   LANGUAGE sql
   STABLE
   SECURITY DEFINER
   SET search_path = public
   AS $$
     SELECT m.role
     FROM memberships m
     JOIN app_users u ON u.id = m.user_id
     WHERE m.account_id = target
       AND m.status = 'active'
       AND (
         u.id = app.current_app_user_id()
         OR (u.neon_user_id IS NOT NULL AND u.neon_user_id = app.current_auth_user_id())
       )
     LIMIT 1
   $$`,
  `CREATE OR REPLACE FUNCTION app.has_school_permission(target uuid, permission text) RETURNS boolean
   LANGUAGE sql
   STABLE
   SECURITY DEFINER
   SET search_path = public
   AS $$
     SELECT CASE COALESCE(app.membership_role(target), '')
       WHEN 'owner' THEN true
       WHEN 'school_admin' THEN permission = ANY (ARRAY[
         'view','write_learning','manage_courses','manage_members','manage_settings',
         'manage_integrations','view_analytics'
       ])
       WHEN 'teacher' THEN permission = ANY (ARRAY[
         'view','write_learning','manage_courses','view_analytics'
       ])
       WHEN 'student' THEN permission = ANY (ARRAY['view','write_learning'])
       ELSE false
     END
   $$`,
  `GRANT EXECUTE ON FUNCTION app.is_privileged_actor() TO PUBLIC`,
  `GRANT EXECUTE ON FUNCTION app.current_app_user_id() TO PUBLIC`,
  `GRANT EXECUTE ON FUNCTION app.member_account_ids() TO PUBLIC`,
  `GRANT EXECUTE ON FUNCTION app.is_account_member(uuid) TO PUBLIC`,
  `GRANT EXECUTE ON FUNCTION app.membership_role(uuid) TO PUBLIC`,
  `GRANT EXECUTE ON FUNCTION app.has_school_permission(uuid, text) TO PUBLIC`,
] as const;

export const DATA_API_CUSTOMER_TABLES = [
  "app_users",
  "accounts",
  "memberships",
  "artifacts",
  "workflows",
  "support_threads",
  "support_messages",
  "enrollments",
  "lesson_progress",
  "certificates",
  "session_rsvps",
  "community_posts",
  "community_comments",
  "community_reactions",
  "community_reports",
  "scorecard_submissions",
] as const;

export const DATA_API_READ_TABLES = [
  "courses",
  "course_stages",
  "lessons",
  "live_sessions",
  "course_templates",
] as const;

export const PRIVILEGED_TABLES = [
  "entitlement_grants",
  "purchases",
  "account_holds",
  "invitations",
  "staff",
  "platform_admins",
  "identity_migrations",
  "admin_audit_log",
  "webhook_receipts",
  "software_accounts",
] as const;

function tablePolicySql(table: string, matchColumn: string, privilegedWrite: boolean) {
  const member = `app.is_account_member(${matchColumn})`;
  const selectUsing = member;
  const writeCheck = privilegedWrite ? `app.is_privileged_actor()` : member;
  return `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS ${table}_isolation ON ${table};
    DROP POLICY IF EXISTS ${table}_select ON ${table};
    DROP POLICY IF EXISTS ${table}_insert ON ${table};
    DROP POLICY IF EXISTS ${table}_update ON ${table};
    DROP POLICY IF EXISTS ${table}_delete ON ${table};
    CREATE POLICY ${table}_select ON ${table} FOR SELECT USING (${selectUsing});
    CREATE POLICY ${table}_insert ON ${table} FOR INSERT WITH CHECK (${writeCheck});
    CREATE POLICY ${table}_update ON ${table} FOR UPDATE USING (${writeCheck}) WITH CHECK (${writeCheck});
    CREATE POLICY ${table}_delete ON ${table} FOR DELETE USING (${writeCheck});
  `;
}

export function rlsPoliciesSql(table: string, matchColumn: string, privilegedWrite: boolean) {
  return tablePolicySql(table, matchColumn, privilegedWrite);
}

export const APP_USERS_RLS_SQL = `
  ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app_users FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS app_users_select ON app_users;
  DROP POLICY IF EXISTS app_users_insert ON app_users;
  DROP POLICY IF EXISTS app_users_update ON app_users;
  DROP POLICY IF EXISTS app_users_delete ON app_users;
  CREATE POLICY app_users_select ON app_users FOR SELECT USING (
    app.is_privileged_actor()
    OR neon_user_id = app.current_auth_user_id()
    OR id = app.current_app_user_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = app_users.id
        AND m.status = 'active'
        AND app.is_account_member(m.account_id)
    )
  );
  CREATE POLICY app_users_insert ON app_users FOR INSERT WITH CHECK (
    app.is_privileged_actor()
    OR neon_user_id = app.current_auth_user_id()
  );
  CREATE POLICY app_users_update ON app_users FOR UPDATE USING (
    app.is_privileged_actor()
    OR neon_user_id = app.current_auth_user_id()
    OR id = app.current_app_user_id()
  ) WITH CHECK (
    app.is_privileged_actor()
    OR neon_user_id = app.current_auth_user_id()
    OR id = app.current_app_user_id()
  );
  CREATE POLICY app_users_delete ON app_users FOR DELETE USING (app.is_privileged_actor());
`;

export const CATALOG_RLS_SQL = `
  ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
  ALTER TABLE courses FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS courses_select ON courses;
  DROP POLICY IF EXISTS courses_write ON courses;
  DROP POLICY IF EXISTS courses_insert ON courses;
  DROP POLICY IF EXISTS courses_update ON courses;
  DROP POLICY IF EXISTS courses_delete ON courses;
  CREATE POLICY courses_select ON courses FOR SELECT USING (
    app.is_privileged_actor()
    OR status = 'published'
    OR (school_id IS NOT NULL AND app.is_account_member(school_id))
  );
  CREATE POLICY courses_insert ON courses FOR INSERT WITH CHECK (
    app.is_privileged_actor()
    OR (school_id IS NOT NULL AND app.has_school_permission(school_id, 'manage_courses'))
  );
  CREATE POLICY courses_update ON courses FOR UPDATE USING (
    app.is_privileged_actor()
    OR (school_id IS NOT NULL AND app.has_school_permission(school_id, 'manage_courses'))
  ) WITH CHECK (
    app.is_privileged_actor()
    OR (school_id IS NOT NULL AND app.has_school_permission(school_id, 'manage_courses'))
  );
  CREATE POLICY courses_delete ON courses FOR DELETE USING (
    app.is_privileged_actor()
    OR (school_id IS NOT NULL AND app.has_school_permission(school_id, 'manage_courses'))
  );

  ALTER TABLE course_stages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE course_stages FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS course_stages_select ON course_stages;
  CREATE POLICY course_stages_select ON course_stages FOR SELECT USING (
    EXISTS (SELECT 1 FROM courses c WHERE c.id = course_stages.course_id)
  );

  ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;
  ALTER TABLE lessons FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS lessons_select ON lessons;
  CREATE POLICY lessons_select ON lessons FOR SELECT USING (
    app.is_privileged_actor()
    OR is_published
    OR EXISTS (
      SELECT 1 FROM courses c
      WHERE c.id = lessons.course_id
        AND c.school_id IS NOT NULL
        AND app.has_school_permission(c.school_id, 'manage_courses')
    )
  );

  ALTER TABLE live_sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE live_sessions FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS live_sessions_select ON live_sessions;
  CREATE POLICY live_sessions_select ON live_sessions FOR SELECT USING (true);

  ALTER TABLE course_templates ENABLE ROW LEVEL SECURITY;
  ALTER TABLE course_templates FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS course_templates_select ON course_templates;
  CREATE POLICY course_templates_select ON course_templates FOR SELECT USING (true);
`;

export const PRIVILEGED_TABLE_RLS_SQL = `
  ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
  ALTER TABLE staff FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS staff_select ON staff;
  DROP POLICY IF EXISTS staff_write ON staff;
  CREATE POLICY staff_select ON staff FOR SELECT USING (app.is_privileged_actor());
  CREATE POLICY staff_write ON staff FOR ALL USING (app.is_privileged_actor()) WITH CHECK (app.is_privileged_actor());

  ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
  ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS platform_admins_all ON platform_admins;
  CREATE POLICY platform_admins_all ON platform_admins FOR ALL
    USING (app.is_privileged_actor()) WITH CHECK (app.is_privileged_actor());

  ALTER TABLE identity_migrations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE identity_migrations FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS identity_migrations_all ON identity_migrations;
  CREATE POLICY identity_migrations_all ON identity_migrations FOR ALL
    USING (app.is_privileged_actor()) WITH CHECK (app.is_privileged_actor());
`;

export const DATA_API_GRANT_SQL = `
  GRANT USAGE ON SCHEMA public TO authenticated, anonymous;
  GRANT SELECT, UPDATE ON TABLE app_users TO authenticated;
  GRANT SELECT ON TABLE accounts TO authenticated;
  GRANT SELECT ON TABLE memberships TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE artifacts TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE workflows TO authenticated;
  GRANT SELECT, INSERT, UPDATE ON TABLE support_threads TO authenticated;
  GRANT SELECT, INSERT ON TABLE support_messages TO authenticated;
  GRANT SELECT ON TABLE enrollments TO authenticated;
  GRANT SELECT, INSERT, UPDATE ON TABLE lesson_progress TO authenticated;
  GRANT SELECT ON TABLE certificates TO authenticated;
  GRANT SELECT, INSERT, DELETE ON TABLE session_rsvps TO authenticated;
  GRANT SELECT, INSERT, UPDATE ON TABLE community_posts TO authenticated;
  GRANT SELECT, INSERT ON TABLE community_comments TO authenticated;
  GRANT SELECT, INSERT, DELETE ON TABLE community_reactions TO authenticated;
  GRANT SELECT, INSERT ON TABLE community_reports TO authenticated;
  GRANT SELECT, INSERT ON TABLE scorecard_submissions TO authenticated;
  GRANT SELECT ON TABLE courses, course_stages, lessons, live_sessions, course_templates TO authenticated;
  GRANT SELECT ON TABLE courses, course_stages, lessons, live_sessions, course_templates TO anonymous;
`;
