DO $$
DECLARE
  capability_role text;
  capability_oid oid;
  capability_state record;
  migration_actor_oid oid;
  migration_actor_is_superuser boolean;
  migration_actor_has_admin boolean;
BEGIN
  SELECT oid, rolsuper
  INTO migration_actor_oid, migration_actor_is_superuser
  FROM pg_roles
  WHERE rolname = current_user;

  FOREACH capability_role IN ARRAY ARRAY[
    'syntholo_migrator',
    'syntholo_member_api',
    'syntholo_staff_api',
    'syntholo_worker'
  ] LOOP
    SELECT oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
           rolreplication, rolbypassrls, rolconfig
    INTO capability_state
    FROM pg_roles
    WHERE rolname = capability_role;

    IF NOT FOUND THEN
      BEGIN
        EXECUTE format(
          'CREATE ROLE %I NOLOGIN PASSWORD NULL',
          capability_role
        );
      EXCEPTION
        WHEN insufficient_privilege OR duplicate_object THEN
          RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
            USING ERRCODE = 'P0001';
      END;
    ELSE
      capability_oid := capability_state.oid;
      IF capability_state.rolcanlogin
        OR capability_state.rolsuper
        OR capability_state.rolcreatedb
        OR capability_state.rolcreaterole
        OR capability_state.rolreplication
        OR capability_state.rolbypassrls
        OR capability_state.rolconfig IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM pg_db_role_setting
          WHERE setrole = capability_oid
        )
        OR EXISTS (
          SELECT 1
          FROM pg_auth_members
          WHERE member = capability_oid
        )
      THEN
        RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
          USING ERRCODE = 'P0001';
      END IF;

      SELECT EXISTS (
        SELECT 1
        FROM pg_auth_members
        WHERE roleid = capability_oid
          AND member = migration_actor_oid
          AND admin_option
      )
      INTO migration_actor_has_admin;

      IF NOT migration_actor_is_superuser AND NOT migration_actor_has_admin THEN
        RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
          USING ERRCODE = 'P0001';
      END IF;

      BEGIN
        EXECUTE format('ALTER ROLE %I PASSWORD NULL', capability_role);
      EXCEPTION
        WHEN insufficient_privilege THEN
          RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
            USING ERRCODE = 'P0001';
      END;
    END IF;

    SELECT oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
           rolreplication, rolbypassrls, rolconfig
    INTO capability_state
    FROM pg_roles
    WHERE rolname = capability_role;
    capability_oid := capability_state.oid;

    IF NOT FOUND
      OR capability_state.rolcanlogin
      OR capability_state.rolsuper
      OR capability_state.rolcreatedb
      OR capability_state.rolcreaterole
      OR capability_state.rolreplication
      OR capability_state.rolbypassrls
      OR capability_state.rolconfig IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM pg_db_role_setting
        WHERE setrole = capability_oid
      )
      OR EXISTS (
        SELECT 1
        FROM pg_auth_members
        WHERE member = capability_oid
      )
    THEN
      RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION prevent_account_id_update() FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO syntholo_migrator;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO
  syntholo_member_api,
  syntholo_staff_api,
  syntholo_worker;
--> statement-breakpoint
GRANT ALL PRIVILEGES ON TABLE
  accounts,
  member_identities,
  memberships,
  staff_identities,
  audit_events,
  outbox_events,
  jobs,
  provider_event_receipts
TO syntholo_migrator;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prevent_account_id_update() TO syntholo_migrator;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  accounts,
  member_identities,
  memberships
TO syntholo_member_api;
--> statement-breakpoint
GRANT SELECT ON TABLE
  accounts,
  member_identities,
  memberships,
  audit_events,
  outbox_events,
  jobs,
  staff_identities
TO syntholo_staff_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE audit_events TO syntholo_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  outbox_events,
  jobs,
  provider_event_receipts
TO syntholo_worker;
--> statement-breakpoint
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_identities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_identities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounts_member_select ON accounts
  FOR SELECT TO syntholo_member_api
  USING (
    id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY accounts_member_insert ON accounts
  FOR INSERT TO syntholo_member_api
  WITH CHECK (
    id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY accounts_member_update ON accounts
  FOR UPDATE TO syntholo_member_api
  USING (
    id = NULLIF(current_setting('app.account_id', true), '')::uuid
  )
  WITH CHECK (
    id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY accounts_staff_read ON accounts
  FOR SELECT TO syntholo_staff_api
  USING (true);
--> statement-breakpoint
CREATE POLICY accounts_migrator_admin ON accounts
  FOR ALL TO syntholo_migrator
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY member_identities_member_select ON member_identities
  FOR SELECT TO syntholo_member_api
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY member_identities_member_insert ON member_identities
  FOR INSERT TO syntholo_member_api
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY member_identities_member_update ON member_identities
  FOR UPDATE TO syntholo_member_api
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY member_identities_staff_read ON member_identities
  FOR SELECT TO syntholo_staff_api
  USING (true);
--> statement-breakpoint
CREATE POLICY member_identities_migrator_admin ON member_identities
  FOR ALL TO syntholo_migrator
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY memberships_member_select ON memberships
  FOR SELECT TO syntholo_member_api
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY memberships_member_insert ON memberships
  FOR INSERT TO syntholo_member_api
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY memberships_member_update ON memberships
  FOR UPDATE TO syntholo_member_api
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY memberships_staff_read ON memberships
  FOR SELECT TO syntholo_staff_api
  USING (true);
--> statement-breakpoint
CREATE POLICY memberships_migrator_admin ON memberships
  FOR ALL TO syntholo_migrator
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY audit_events_staff_read ON audit_events
  FOR SELECT TO syntholo_staff_api
  USING (true);
--> statement-breakpoint
CREATE POLICY audit_events_worker_read ON audit_events
  FOR SELECT TO syntholo_worker
  USING (true);
--> statement-breakpoint
CREATE POLICY audit_events_worker_insert ON audit_events
  FOR INSERT TO syntholo_worker
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY audit_events_migrator_admin ON audit_events
  FOR ALL TO syntholo_migrator
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY outbox_events_staff_read ON outbox_events
  FOR SELECT TO syntholo_staff_api
  USING (true);
--> statement-breakpoint
CREATE POLICY outbox_events_worker_read ON outbox_events
  FOR SELECT TO syntholo_worker
  USING (true);
--> statement-breakpoint
CREATE POLICY outbox_events_worker_insert ON outbox_events
  FOR INSERT TO syntholo_worker
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY outbox_events_worker_update ON outbox_events
  FOR UPDATE TO syntholo_worker
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY outbox_events_migrator_admin ON outbox_events
  FOR ALL TO syntholo_migrator
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY jobs_staff_read ON jobs
  FOR SELECT TO syntholo_staff_api
  USING (true);
--> statement-breakpoint
CREATE POLICY jobs_worker_read ON jobs
  FOR SELECT TO syntholo_worker
  USING (true);
--> statement-breakpoint
CREATE POLICY jobs_worker_insert ON jobs
  FOR INSERT TO syntholo_worker
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY jobs_worker_update ON jobs
  FOR UPDATE TO syntholo_worker
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY jobs_migrator_admin ON jobs
  FOR ALL TO syntholo_migrator
  USING (true)
  WITH CHECK (true);
