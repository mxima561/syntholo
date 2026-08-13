DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syntholo_migrator') THEN
    CREATE ROLE syntholo_migrator
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE syntholo_migrator WITH
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syntholo_member_api') THEN
    CREATE ROLE syntholo_member_api
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE syntholo_member_api WITH
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syntholo_staff_api') THEN
    CREATE ROLE syntholo_staff_api
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE syntholo_staff_api WITH
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syntholo_worker') THEN
    CREATE ROLE syntholo_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE syntholo_worker WITH
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
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
CREATE POLICY accounts_member_scope ON accounts
  FOR ALL TO syntholo_member_api
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
CREATE POLICY member_identities_member_scope ON member_identities
  FOR ALL TO syntholo_member_api
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
CREATE POLICY memberships_member_scope ON memberships
  FOR ALL TO syntholo_member_api
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
CREATE POLICY audit_events_member_scope ON audit_events
  FOR ALL TO syntholo_member_api
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
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
CREATE POLICY outbox_events_member_scope ON outbox_events
  FOR ALL TO syntholo_member_api
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
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
CREATE POLICY jobs_member_scope ON jobs
  FOR ALL TO syntholo_member_api
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
  );
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
