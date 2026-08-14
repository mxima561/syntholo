DO $roles$
DECLARE
  role_state record;
  role_oid oid;
  migration_actor_oid oid;
  migration_actor_is_superuser boolean;
  migration_actor_has_admin boolean;
BEGIN
  SELECT oid,rolsuper INTO migration_actor_oid,migration_actor_is_superuser
    FROM pg_roles WHERE rolname=current_user;
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
         rolbypassrls, rolconfig INTO role_state
  FROM pg_roles WHERE rolname = 'syntholo_system_api';
  IF NOT FOUND THEN
    BEGIN
      CREATE ROLE syntholo_system_api NOLOGIN PASSWORD NULL;
    EXCEPTION WHEN insufficient_privilege OR duplicate_object THEN
      RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
        USING ERRCODE = 'P0001';
    END;
  ELSIF role_state.rolcanlogin OR role_state.rolsuper OR role_state.rolcreatedb
    OR role_state.rolcreaterole OR role_state.rolreplication
    OR role_state.rolbypassrls OR role_state.rolconfig IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_auth_members
               WHERE member = 'syntholo_system_api'::regrole)
    OR EXISTS (SELECT 1 FROM pg_db_role_setting
               WHERE setrole = 'syntholo_system_api'::regrole)
    OR EXISTS (SELECT 1 FROM pg_class
               WHERE relowner='syntholo_system_api'::regrole)
    OR EXISTS (SELECT 1 FROM pg_proc
               WHERE proowner='syntholo_system_api'::regrole)
    OR EXISTS (SELECT 1 FROM pg_namespace
               WHERE nspowner='syntholo_system_api'::regrole)
    OR EXISTS (SELECT 1 FROM pg_database
               WHERE datdba='syntholo_system_api'::regrole)
    OR EXISTS (SELECT 1 FROM pg_namespace n
               WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_'
                 AND ((n.nspname='public'
                       AND has_schema_privilege('syntholo_system_api',n.oid,'CREATE'))
                   OR (n.nspname<>'public' AND (
                       has_schema_privilege('syntholo_system_api',n.oid,'USAGE')
                       OR has_schema_privilege('syntholo_system_api',n.oid,'CREATE')))))
  THEN
    RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
      USING ERRCODE = 'P0001';
  ELSE
    SELECT oid INTO role_oid FROM pg_roles
      WHERE rolname='syntholo_system_api';
    SELECT EXISTS(SELECT 1 FROM pg_auth_members
      WHERE roleid=role_oid AND member=migration_actor_oid AND admin_option)
      INTO migration_actor_has_admin;
    IF NOT migration_actor_is_superuser AND NOT migration_actor_has_admin THEN
      RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
        USING ERRCODE='P0001';
    END IF;
    BEGIN
      ALTER ROLE syntholo_system_api PASSWORD NULL;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'SYNTHOLO_CAPABILITY_ROLE_PROVISIONING_REQUIRED'
        USING ERRCODE='P0001';
    END;
  END IF;
END;
$roles$;
--> statement-breakpoint
DO $database_acl$
BEGIN
  EXECUTE format(
    'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',
    current_database()
  );
END;
$database_acl$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM syntholo_system_api;
GRANT USAGE ON SCHEMA public TO syntholo_system_api;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM syntholo_system_api;
DO $column_acl$
DECLARE object record;
BEGIN
  FOR object IN
    SELECT n.nspname,c.relname,
      string_agg(format('%I',a.attname),',' ORDER BY a.attnum) columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
      AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
    GROUP BY n.nspname,c.relname
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM syntholo_system_api',
      object.columns,object.nspname,object.relname);
  END LOOP;
END;
$column_acl$;
--> statement-breakpoint
ALTER TABLE accounts
  ADD COLUMN owner_established_at timestamptz(3);
DO $preflight$
BEGIN
  IF EXISTS(
    SELECT account_id FROM memberships
    WHERE role='owner' AND status='active'
    GROUP BY account_id HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'SYNTHOLO_0005_OWNER_PREFLIGHT_FAILED' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM accounts a
    WHERE (SELECT count(*) FROM memberships m WHERE m.account_id=a.id
      AND m.role='owner' AND m.status='active')=1
      AND (
        NOT isfinite(coalesce((SELECT min(m.created_at) FROM memberships m
          WHERE m.account_id=a.id AND m.role='owner' AND m.status='active'),a.updated_at))
        OR coalesce((SELECT min(m.created_at) FROM memberships m
          WHERE m.account_id=a.id AND m.role='owner' AND m.status='active'),a.updated_at)
          < '2000-01-01 00:00:00+00'::timestamptz
        OR coalesce((SELECT min(m.created_at) FROM memberships m
          WHERE m.account_id=a.id AND m.role='owner' AND m.status='active'),a.updated_at)
          >= '10000-01-01 00:00:00+00'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'SYNTHOLO_0005_OWNER_PREFLIGHT_FAILED' USING ERRCODE='23514';
  END IF;
END;
$preflight$;
UPDATE accounts a SET owner_established_at=date_trunc('milliseconds',coalesce(
  (SELECT min(m.created_at) FROM memberships m WHERE m.account_id=a.id
    AND m.role='owner' AND m.status='active'),a.updated_at))
WHERE (SELECT count(*) FROM memberships m WHERE m.account_id=a.id
  AND m.role='owner' AND m.status='active')=1;
ALTER TABLE memberships
  ADD CONSTRAINT memberships_id_account_unique UNIQUE(id,account_id);
--> statement-breakpoint
CREATE UNIQUE INDEX memberships_one_active_owner_per_account
  ON memberships(account_id)
  WHERE role = 'owner' AND status = 'active';
--> statement-breakpoint
CREATE TABLE entitlement_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  offer_code text,
  academy_source_registry_id uuid,
  provenance text NOT NULL,
  created_at timestamptz(3) NOT NULL,
  CONSTRAINT entitlement_sources_global_source_unique UNIQUE(source_kind,source_id),
  CONSTRAINT entitlement_sources_id_account_unique UNIQUE(id,account_id),
  CONSTRAINT entitlement_sources_core_identity_unique UNIQUE(id,account_id,source_kind,source_id),
  CONSTRAINT entitlement_sources_academy_parent_fk FOREIGN KEY(academy_source_registry_id,account_id)
    REFERENCES entitlement_sources(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT entitlement_sources_kind_check CHECK(source_kind IN ('purchase','subscription','administrative')),
  CONSTRAINT entitlement_sources_source_id_check CHECK(octet_length(source_id) BETWEEN 1 AND 255),
  CONSTRAINT entitlement_sources_offer_check CHECK(offer_code IS NULL OR offer_code IN ('guided_pilot','self_paced','operator_club_monthly','operator_club_annual','business_os')),
  CONSTRAINT entitlement_sources_product_offer_check CHECK(
    (source_kind='administrative' AND academy_source_registry_id IS NULL)
    OR (source_kind='purchase' AND offer_code IN ('guided_pilot','self_paced') AND academy_source_registry_id IS NULL)
    OR (source_kind='purchase' AND offer_code='business_os' AND academy_source_registry_id IS NULL)
    OR (source_kind='subscription' AND offer_code IN ('operator_club_monthly','operator_club_annual') AND academy_source_registry_id IS NOT NULL)
    OR (source_kind='subscription' AND offer_code='business_os' AND academy_source_registry_id IS NULL)),
  CONSTRAINT entitlement_sources_provenance_check CHECK(octet_length(provenance) BETWEEN 1 AND 255)
);
CREATE INDEX entitlement_sources_account_idx ON entitlement_sources(account_id);
--> statement-breakpoint
CREATE TABLE entitlement_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  source_registry_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  offer_code text,
  capability text NOT NULL,
  status text NOT NULL,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3),
  provenance text NOT NULL,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT entitlement_grants_source_core_identity_fk FOREIGN KEY
    (source_registry_id,account_id,source_kind,source_id) REFERENCES
    entitlement_sources(id,account_id,source_kind,source_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT entitlement_grants_source_capability_unique UNIQUE(account_id,source_kind,source_id,capability),
  CONSTRAINT entitlement_grants_id_account_unique UNIQUE(id,account_id),
  CONSTRAINT entitlement_grants_capability_check CHECK(capability IN ('academy_course','support','circle_write','operator_club','business_os')),
  CONSTRAINT entitlement_grants_status_check CHECK(status IN ('active','grace','expired','refunded','revoked')),
  CONSTRAINT entitlement_grants_kind_check CHECK(source_kind IN ('purchase','subscription','administrative')),
  CONSTRAINT entitlement_grants_source_id_check CHECK(octet_length(source_id) BETWEEN 1 AND 255),
  CONSTRAINT entitlement_grants_interval_check CHECK(ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT entitlement_grants_grace_check CHECK(status <> 'grace' OR (source_kind='subscription' AND ends_at IS NOT NULL)),
  CONSTRAINT entitlement_grants_business_os_subscription_check CHECK(
    capability<>'business_os'
    OR (source_kind='subscription' AND offer_code='business_os' AND ends_at IS NOT NULL)),
  CONSTRAINT entitlement_grants_offer_check CHECK(offer_code IS NULL OR offer_code IN ('guided_pilot','self_paced','operator_club_monthly','operator_club_annual','business_os')),
  CONSTRAINT entitlement_grants_provenance_check CHECK(octet_length(provenance) BETWEEN 1 AND 255)
);
CREATE INDEX entitlement_grants_account_effective_idx
  ON entitlement_grants(account_id,capability,starts_at,ends_at);
CREATE INDEX entitlement_grants_source_registry_idx ON entitlement_grants(source_registry_id);
CREATE UNIQUE INDEX entitlement_grants_one_structural_academy_purchase_slot
  ON entitlement_grants(account_id)
  WHERE capability='academy_course' AND source_kind='purchase'
    AND offer_code IN ('self_paced','guided_pilot') AND status IN ('active','grace');
CREATE UNIQUE INDEX entitlement_grants_one_effective_club_subscription
  ON entitlement_grants(account_id)
  WHERE capability='operator_club' AND source_kind='subscription'
    AND offer_code IN ('operator_club_monthly','operator_club_annual')
    AND status IN ('active','grace');
CREATE UNIQUE INDEX entitlement_grants_one_effective_business_os_subscription
  ON entitlement_grants(account_id)
  WHERE capability='business_os' AND source_kind='subscription'
    AND offer_code='business_os' AND status IN ('active','grace');
CREATE TABLE business_os_setup_receipts (
  source_registry_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  reconciliation_id uuid,
  status text NOT NULL,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT business_os_setup_receipts_source_account_fk
    FOREIGN KEY(source_registry_id,account_id)
    REFERENCES entitlement_sources(id,account_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT business_os_setup_receipts_reconciliation_id_unique
    UNIQUE(reconciliation_id),
  CONSTRAINT business_os_setup_receipts_status_check
    CHECK(status IN ('paid','paid_reconciliation','refunded','dispute_lost')),
  CONSTRAINT business_os_setup_receipts_reconciliation_check
    CHECK(status<>'paid_reconciliation' OR reconciliation_id IS NOT NULL),
  CONSTRAINT business_os_setup_receipts_time_check CHECK(
    isfinite(created_at) AND isfinite(updated_at)
    AND created_at>='2000-01-01 00:00:00+00'::timestamptz
    AND created_at<'10000-01-01 00:00:00+00'::timestamptz
    AND updated_at>='2000-01-01 00:00:00+00'::timestamptz
    AND updated_at<'10000-01-01 00:00:00+00'::timestamptz
    AND updated_at>=created_at
    AND created_at=date_trunc('milliseconds',created_at)
    AND updated_at=date_trunc('milliseconds',updated_at))
);
CREATE INDEX business_os_setup_receipts_account_idx
  ON business_os_setup_receipts(account_id);
CREATE UNIQUE INDEX business_os_setup_receipts_one_nonterminal_epoch
  ON business_os_setup_receipts(account_id)
  WHERE status='paid';
CREATE TABLE commerce_fulfillment_receipts (
  source_registry_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  reconciliation_id uuid,
  status text NOT NULL,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT commerce_fulfillment_receipts_source_account_fk
    FOREIGN KEY(source_registry_id,account_id)
    REFERENCES entitlement_sources(id,account_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT commerce_fulfillment_receipts_reconciliation_id_unique
    UNIQUE(reconciliation_id),
  CONSTRAINT commerce_fulfillment_receipts_status_check
    CHECK(status IN ('fulfilled','reconciliation','cancelled','refunded','dispute_lost')),
  CONSTRAINT commerce_fulfillment_receipts_reconciliation_check
    CHECK(status<>'reconciliation' OR reconciliation_id IS NOT NULL),
  CONSTRAINT commerce_fulfillment_receipts_interval_check
    CHECK(ends_at IS NULL OR ends_at>starts_at),
  CONSTRAINT commerce_fulfillment_receipts_time_check CHECK(
    isfinite(starts_at) AND (ends_at IS NULL OR isfinite(ends_at))
    AND isfinite(created_at) AND isfinite(updated_at)
    AND starts_at>='2000-01-01 00:00:00+00'::timestamptz
    AND starts_at<'10000-01-01 00:00:00+00'::timestamptz
    AND (ends_at IS NULL OR ends_at<'10000-01-01 00:00:00+00'::timestamptz)
    AND created_at>='2000-01-01 00:00:00+00'::timestamptz
    AND created_at<'10000-01-01 00:00:00+00'::timestamptz
    AND updated_at>='2000-01-01 00:00:00+00'::timestamptz
    AND updated_at<'10000-01-01 00:00:00+00'::timestamptz
    AND updated_at>=created_at
    AND starts_at=date_trunc('milliseconds',starts_at)
    AND (ends_at IS NULL OR ends_at=date_trunc('milliseconds',ends_at))
    AND created_at=date_trunc('milliseconds',created_at)
    AND updated_at=date_trunc('milliseconds',updated_at))
);
CREATE INDEX commerce_fulfillment_receipts_account_idx
  ON commerce_fulfillment_receipts(account_id);
CREATE TABLE commerce_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  command_kind text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  request_fingerprint text NOT NULL,
  reason_code text NOT NULL,
  incident_kind text NOT NULL,
  target_source_registry_id uuid REFERENCES entitlement_sources(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  expected_paid_through_at timestamptz(3),
  status text NOT NULL DEFAULT 'open',
  review_due_at timestamptz(3) NOT NULL,
  claimed_by_staff_id uuid REFERENCES staff_identities(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  claimed_at timestamptz(3),
  resolved_at timestamptz(3),
  resolution_code text,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT commerce_reconciliations_event_fingerprint_unique
    UNIQUE(account_id,command_kind,source_kind,source_id,request_fingerprint),
  CONSTRAINT commerce_reconciliations_id_account_unique UNIQUE(id,account_id),
  CONSTRAINT commerce_reconciliations_kind_check CHECK(
    command_kind IN ('fulfill_product','business_os_setup_paid','open_dispute',
      'resolve_dispute','club_cancelled','business_os_cancelled','refund_product')),
  CONSTRAINT commerce_reconciliations_source_kind_check
    CHECK(octet_length(source_kind) BETWEEN 1 AND 64),
  CONSTRAINT commerce_reconciliations_source_id_check
    CHECK(octet_length(source_id) BETWEEN 1 AND 255),
  CONSTRAINT commerce_reconciliations_fingerprint_check
    CHECK(request_fingerprint~'^[0-9a-f]{64}$'),
  CONSTRAINT commerce_reconciliations_reason_check
    CHECK(reason_code~'^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT commerce_reconciliations_incident_kind_check CHECK(
    incident_kind IN ('parked_paid_receipt','provider_source_collision',
      'linked_academy_refund','linked_club_cancellation')),
  CONSTRAINT commerce_reconciliations_status_check CHECK(
    status IN ('open','claimed','resolved_fulfilled','resolved_refund',
      'resolved_manual')),
  CONSTRAINT commerce_reconciliations_resolution_check CHECK(
    resolution_code IS NULL OR resolution_code IN ('fulfilled','refund','manual',
      'club_cancelled','club_refunded','abort_refund',
      'dispute_lost','superseded_by_dispute')),
  CONSTRAINT commerce_reconciliations_state_check CHECK(
    (status='open' AND claimed_by_staff_id IS NULL AND claimed_at IS NULL
      AND resolved_at IS NULL AND resolution_code IS NULL)
    OR (status='claimed' AND claimed_by_staff_id IS NOT NULL
      AND claimed_at IS NOT NULL AND resolved_at IS NULL
      AND resolution_code IS NULL)
    OR (status LIKE 'resolved_%' AND resolved_at IS NOT NULL
      AND resolution_code IS NOT NULL)),
  CONSTRAINT commerce_reconciliations_time_check CHECK(
    isfinite(review_due_at) AND isfinite(created_at) AND isfinite(updated_at)
    AND (claimed_at IS NULL OR isfinite(claimed_at))
    AND (resolved_at IS NULL OR isfinite(resolved_at))
    AND (expected_paid_through_at IS NULL
      OR (isfinite(expected_paid_through_at)
        AND expected_paid_through_at>='2000-01-01 00:00:00+00'::timestamptz
        AND expected_paid_through_at<'10000-01-01 00:00:00+00'::timestamptz
        AND expected_paid_through_at=date_trunc('milliseconds',
          expected_paid_through_at)))
    AND review_due_at=created_at+interval '48 hours'
    AND updated_at>=created_at
    AND (claimed_at IS NULL OR claimed_at>=created_at)
    AND (resolved_at IS NULL OR resolved_at>=created_at)
    AND review_due_at=date_trunc('milliseconds',review_due_at)
    AND created_at=date_trunc('milliseconds',created_at)
    AND updated_at=date_trunc('milliseconds',updated_at)
    AND (claimed_at IS NULL OR claimed_at=date_trunc('milliseconds',claimed_at))
    AND (resolved_at IS NULL OR resolved_at=date_trunc('milliseconds',resolved_at)))
);
CREATE INDEX commerce_reconciliations_staff_queue_idx
  ON commerce_reconciliations(status,review_due_at,id)
  WHERE status IN ('open','claimed');
CREATE INDEX commerce_reconciliations_account_idx
  ON commerce_reconciliations(account_id,created_at,id);
ALTER TABLE commerce_fulfillment_receipts
  ADD CONSTRAINT commerce_fulfillment_receipts_reconciliation_fk
  FOREIGN KEY(reconciliation_id,account_id)
  REFERENCES commerce_reconciliations(id,account_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE business_os_setup_receipts
  ADD CONSTRAINT business_os_setup_receipts_reconciliation_fk
  FOREIGN KEY(reconciliation_id,account_id)
  REFERENCES commerce_reconciliations(id,account_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION syntholo_validate_receipt_reconciliation(p_reconciliation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_row commerce_reconciliations%ROWTYPE; v_count integer;
DECLARE v_source uuid; v_account uuid;
BEGIN
  IF p_reconciliation IS NULL THEN RETURN; END IF;
  SELECT * INTO v_row FROM commerce_reconciliations WHERE id=p_reconciliation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SYNTHOLO_RECEIPT_RECONCILIATION_INVALID'
      USING ERRCODE='23514';
  END IF;
  SELECT count(*)::integer,(array_agg(source_registry_id))[1],
    (array_agg(account_id))[1]
    INTO v_count,v_source,v_account FROM (
      SELECT source_registry_id,account_id FROM business_os_setup_receipts
        WHERE reconciliation_id=p_reconciliation
      UNION ALL
      SELECT source_registry_id,account_id FROM commerce_fulfillment_receipts
        WHERE reconciliation_id=p_reconciliation
    ) receipt;
  IF v_row.incident_kind='parked_paid_receipt' THEN
    IF v_count<>1 OR v_account<>v_row.account_id
      OR v_source IS DISTINCT FROM v_row.target_source_registry_id THEN
      RAISE EXCEPTION 'SYNTHOLO_RECEIPT_RECONCILIATION_INVALID'
        USING ERRCODE='23514';
    END IF;
  ELSIF v_count<>0 THEN
    RAISE EXCEPTION 'SYNTHOLO_RECEIPT_RECONCILIATION_INVALID'
      USING ERRCODE='23514';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_validate_receipt_reconciliation(uuid) FROM PUBLIC;
CREATE FUNCTION syntholo_receipt_reconciliation_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_TABLE_NAME='commerce_reconciliations' THEN
    PERFORM syntholo_validate_receipt_reconciliation(NEW.id);
  ELSE
    PERFORM syntholo_validate_receipt_reconciliation(NEW.reconciliation_id);
    IF TG_OP='UPDATE'
      AND OLD.reconciliation_id IS DISTINCT FROM NEW.reconciliation_id THEN
      PERFORM syntholo_validate_receipt_reconciliation(OLD.reconciliation_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_receipt_reconciliation_constraint() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER business_os_setup_receipt_reconciliation_constraint
  AFTER INSERT OR UPDATE ON business_os_setup_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION syntholo_receipt_reconciliation_constraint();
CREATE CONSTRAINT TRIGGER commerce_fulfillment_receipt_reconciliation_constraint
  AFTER INSERT OR UPDATE ON commerce_fulfillment_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION syntholo_receipt_reconciliation_constraint();
CREATE CONSTRAINT TRIGGER commerce_reconciliation_receipt_constraint
  AFTER INSERT OR UPDATE ON commerce_reconciliations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION syntholo_receipt_reconciliation_constraint();
CREATE TABLE administrative_grant_restorations (
  new_source_registry_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  terminal_grant_id uuid NOT NULL UNIQUE,
  created_at timestamptz(3) NOT NULL,
  CONSTRAINT administrative_restorations_source_account_fk
    FOREIGN KEY(new_source_registry_id,account_id)
    REFERENCES entitlement_sources(id,account_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT administrative_restorations_grant_account_fk
    FOREIGN KEY(terminal_grant_id,account_id)
    REFERENCES entitlement_grants(id,account_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT administrative_restorations_time_check CHECK(
    isfinite(created_at)
    AND created_at>='2000-01-01 00:00:00+00'::timestamptz
    AND created_at<'10000-01-01 00:00:00+00'::timestamptz
    AND created_at=date_trunc('milliseconds',created_at))
);
CREATE INDEX administrative_grant_restorations_account_idx
  ON administrative_grant_restorations(account_id);
--> statement-breakpoint
CREATE TABLE club_subscription_cancellations (
  source_registry_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  paid_through_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  CONSTRAINT club_subscription_cancellations_source_account_fk
    FOREIGN KEY(source_registry_id,account_id)
    REFERENCES entitlement_sources(id,account_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT club_subscription_cancellations_time_check CHECK(
    isfinite(paid_through_at) AND isfinite(created_at)
    AND paid_through_at>='2000-01-01 00:00:00+00'::timestamptz
    AND paid_through_at<'10000-01-01 00:00:00+00'::timestamptz
    AND created_at>='2000-01-01 00:00:00+00'::timestamptz
    AND created_at<'10000-01-01 00:00:00+00'::timestamptz
    AND paid_through_at=date_trunc('milliseconds',paid_through_at)
    AND created_at=date_trunc('milliseconds',created_at))
);
CREATE INDEX club_subscription_cancellations_account_idx
  ON club_subscription_cancellations(account_id);
CREATE TABLE business_os_subscription_cancellations (
  source_registry_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  paid_through_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  CONSTRAINT business_os_subscription_cancellations_source_account_fk
    FOREIGN KEY(source_registry_id,account_id)
    REFERENCES entitlement_sources(id,account_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT business_os_subscription_cancellations_time_check CHECK(
    isfinite(paid_through_at) AND isfinite(created_at)
    AND paid_through_at>='2000-01-01 00:00:00+00'::timestamptz
    AND paid_through_at<'10000-01-01 00:00:00+00'::timestamptz
    AND created_at>='2000-01-01 00:00:00+00'::timestamptz
    AND created_at<'10000-01-01 00:00:00+00'::timestamptz
    AND paid_through_at=date_trunc('milliseconds',paid_through_at)
    AND created_at=date_trunc('milliseconds',created_at))
);
CREATE INDEX business_os_subscription_cancellations_account_idx
  ON business_os_subscription_cancellations(account_id);
--> statement-breakpoint
CREATE TABLE account_hold_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  target_source_registry_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL,
  CONSTRAINT account_hold_sources_global_source_unique UNIQUE(source_kind,source_id),
  CONSTRAINT account_hold_sources_id_account_unique UNIQUE(id,account_id),
  CONSTRAINT account_hold_sources_target_account_fk
    FOREIGN KEY(target_source_registry_id,account_id)
    REFERENCES entitlement_sources(id,account_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT account_hold_sources_kind_check CHECK(octet_length(source_kind) BETWEEN 1 AND 64),
  CONSTRAINT account_hold_sources_id_check CHECK(octet_length(source_id) BETWEEN 1 AND 255)
);
CREATE INDEX account_hold_sources_account_idx ON account_hold_sources(account_id);
CREATE TABLE account_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  source_registry_id uuid NOT NULL,
  kind text NOT NULL,
  created_at timestamptz(3) NOT NULL,
  released_at timestamptz(3),
  CONSTRAINT account_holds_source_account_fk FOREIGN KEY(source_registry_id,account_id)
    REFERENCES account_hold_sources(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT account_holds_source_kind_unique UNIQUE(source_registry_id,kind),
  CONSTRAINT account_holds_kind_check CHECK(kind IN ('commerce','seat_changes','business_os_activation')),
  CONSTRAINT account_holds_release_check CHECK(released_at IS NULL OR released_at >= created_at)
);
CREATE INDEX account_holds_account_open_idx ON account_holds(account_id,kind);
--> statement-breakpoint
CREATE TABLE seat_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  normalized_email text NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  CONSTRAINT seat_invitations_id_account_unique UNIQUE(id,account_id),
  CONSTRAINT seat_invitations_email_check CHECK(normalized_email=lower(btrim(normalized_email)) AND octet_length(normalized_email) BETWEEN 3 AND 320),
  CONSTRAINT seat_invitations_expiry_check CHECK(expires_at=created_at+interval '168 hours')
);
CREATE INDEX seat_invitations_account_idx ON seat_invitations(account_id,created_at);
CREATE TABLE seat_invitation_token_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  invitation_id uuid NOT NULL,
  generation integer NOT NULL,
  token_hash bytea NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  consumed_at timestamptz(3),
  superseded_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  CONSTRAINT seat_invitation_tokens_invitation_account_fk FOREIGN KEY(invitation_id,account_id)
    REFERENCES seat_invitations(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT seat_invitation_tokens_generation_unique UNIQUE(invitation_id,generation),
  CONSTRAINT seat_invitation_tokens_hash_unique UNIQUE(token_hash),
  CONSTRAINT seat_invitation_tokens_generation_check CHECK(generation>0),
  CONSTRAINT seat_invitation_tokens_hash_check CHECK(octet_length(token_hash)=32),
  CONSTRAINT seat_invitation_tokens_state_check CHECK(NOT(consumed_at IS NOT NULL AND superseded_at IS NOT NULL)),
  CONSTRAINT seat_invitation_tokens_time_check CHECK(expires_at>created_at AND (consumed_at IS NULL OR consumed_at>=created_at) AND (superseded_at IS NULL OR superseded_at>=created_at))
);
CREATE INDEX seat_invitation_tokens_live_idx ON seat_invitation_token_generations(token_hash,expires_at);
CREATE UNIQUE INDEX seat_invitation_tokens_one_live_generation
  ON seat_invitation_token_generations(invitation_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
--> statement-breakpoint
CREATE TABLE seat_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  slot integer NOT NULL,
  source_registry_id uuid NOT NULL,
  state text NOT NULL,
  membership_id uuid,
  invitation_id uuid,
  expires_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT seat_reservations_source_account_fk FOREIGN KEY(source_registry_id,account_id)
    REFERENCES entitlement_sources(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT seat_reservations_membership_account_fk FOREIGN KEY(membership_id,account_id)
    REFERENCES memberships(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT seat_reservations_invitation_account_fk FOREIGN KEY(invitation_id,account_id)
    REFERENCES seat_invitations(id,account_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT seat_reservations_invitation_unique UNIQUE(invitation_id),
  CONSTRAINT seat_reservations_slot_check CHECK(slot BETWEEN 1 AND 3),
  CONSTRAINT seat_reservations_state_check CHECK(state IN ('pending','active','expired','revoked')),
  CONSTRAINT seat_reservations_columns_check CHECK(
    (state='pending' AND membership_id IS NULL AND invitation_id IS NOT NULL AND expires_at IS NOT NULL)
    OR (state='active' AND membership_id IS NOT NULL AND expires_at IS NULL)
    OR (state='expired' AND membership_id IS NULL
      AND invitation_id IS NOT NULL AND expires_at IS NOT NULL)
    OR (state='revoked' AND (
      (membership_id IS NULL AND invitation_id IS NOT NULL AND expires_at IS NOT NULL)
      OR (membership_id IS NOT NULL AND expires_at IS NULL))))
);
CREATE INDEX seat_reservations_account_idx ON seat_reservations(account_id,slot);
CREATE UNIQUE INDEX seat_reservations_occupied_slot_unique
  ON seat_reservations(account_id,slot) WHERE state IN ('pending','active');
CREATE UNIQUE INDEX seat_reservations_active_membership_unique
  ON seat_reservations(membership_id) WHERE state='active';
--> statement-breakpoint
CREATE TABLE access_decision_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  correlation_id uuid NOT NULL,
  command_id uuid NOT NULL,
  check_kind text NOT NULL,
  allowed boolean NOT NULL,
  reason_code text NOT NULL,
  source_grant_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  snapshot_version integer,
  snapshot_hash text,
  occurred_at timestamptz(3) NOT NULL,
  CONSTRAINT access_decision_audit_command_check_unique UNIQUE(account_id,command_id,check_kind),
  CONSTRAINT access_decision_audit_actor_type_check CHECK(actor_type IN ('member','staff','system')),
  CONSTRAINT access_decision_audit_actor_id_check CHECK(octet_length(actor_id) BETWEEN 1 AND 255),
  CONSTRAINT access_decision_audit_check_kind_check CHECK(octet_length(check_kind) BETWEEN 1 AND 128),
  CONSTRAINT access_decision_audit_reason_check CHECK(octet_length(reason_code) BETWEEN 1 AND 128),
  CONSTRAINT access_decision_audit_source_ids_check CHECK(array_position(source_grant_ids,NULL) IS NULL AND cardinality(source_grant_ids)<=64),
  CONSTRAINT access_decision_audit_snapshot_check CHECK((snapshot_version IS NULL)=(snapshot_hash IS NULL) AND (snapshot_version IS NULL OR (snapshot_version=1 AND snapshot_hash ~ '^[0-9a-f]{64}$')))
);
CREATE INDEX access_decision_audit_account_time_idx ON access_decision_audit(account_id,occurred_at);
--> statement-breakpoint
CREATE TABLE entitlement_commands (
  command_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  command_kind text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  first_correlation_id uuid NOT NULL,
  input_hash text NOT NULL,
  outcome text,
  result jsonb,
  occurred_at timestamptz(3) NOT NULL,
  completed_at timestamptz(3),
  CONSTRAINT entitlement_commands_kind_check CHECK(command_kind IN (
    'fulfill_product','establish_owner','reserve_seat','resend_invitation',
    'redeem_invitation','expire_invitation','revoke_seat','replace_seat','transfer_owner',
    'refund_product','open_dispute','resolve_dispute','club_payment_failed',
    'club_payment_recovered','club_cancelled','expire_club','expire_support',
    'business_os_payment_failed','business_os_payment_recovered',
    'business_os_renewed','business_os_cancelled','expire_business_os',
    'grant_administrative','revoke_administrative','restore_administrative',
    'business_os_setup_paid','reconcile_business_os_setup',
    'reconcile_product_fulfillment','suspend_account','reactivate_account',
    'revoke_member','claim_commerce_reconciliation',
    'resolve_commerce_reconciliation')),
  CONSTRAINT entitlement_commands_actor_check CHECK(
    actor_type IN ('member','staff','system')
    AND octet_length(actor_id) BETWEEN 1 AND 255),
  CONSTRAINT entitlement_commands_hash_check CHECK(input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT entitlement_commands_completion_check CHECK(
    (outcome IS NULL AND result IS NULL AND completed_at IS NULL)
    OR (outcome IN ('applied','denied') AND jsonb_typeof(result)='object'
      AND octet_length(result::text)<=16384 AND completed_at IS NOT NULL
      AND completed_at>=occurred_at))
);
CREATE INDEX entitlement_commands_account_time_idx
  ON entitlement_commands(account_id,occurred_at);
--> statement-breakpoint
ALTER TABLE accounts ADD CONSTRAINT accounts_owner_established_time_check CHECK(
  owner_established_at IS NULL OR (
    isfinite(owner_established_at)
    AND owner_established_at>='2000-01-01 00:00:00+00'::timestamptz
    AND owner_established_at<'10000-01-01 00:00:00+00'::timestamptz
    AND owner_established_at=date_trunc('milliseconds',owner_established_at)));
ALTER TABLE entitlement_sources ADD CONSTRAINT entitlement_sources_created_time_check CHECK(
  isfinite(created_at) AND created_at>='2000-01-01 00:00:00+00'::timestamptz
  AND created_at<'10000-01-01 00:00:00+00'::timestamptz
  AND created_at=date_trunc('milliseconds',created_at));
ALTER TABLE entitlement_grants ADD CONSTRAINT entitlement_grants_time_check CHECK(
  isfinite(starts_at)
  AND (ends_at IS NULL OR isfinite(ends_at))
  AND isfinite(created_at) AND isfinite(updated_at)
  AND starts_at>='2000-01-01 00:00:00+00'::timestamptz
  AND starts_at<'10000-01-01 00:00:00+00'::timestamptz
  AND (ends_at IS NULL OR (ends_at>='2000-01-01 00:00:00+00'::timestamptz
    AND ends_at<'10000-01-01 00:00:00+00'::timestamptz))
  AND created_at>='2000-01-01 00:00:00+00'::timestamptz
  AND created_at<'10000-01-01 00:00:00+00'::timestamptz
  AND updated_at>='2000-01-01 00:00:00+00'::timestamptz
  AND updated_at<'10000-01-01 00:00:00+00'::timestamptz
  AND starts_at=date_trunc('milliseconds',starts_at)
  AND (ends_at IS NULL OR ends_at=date_trunc('milliseconds',ends_at))
  AND created_at=date_trunc('milliseconds',created_at)
  AND updated_at=date_trunc('milliseconds',updated_at));
ALTER TABLE account_hold_sources ADD CONSTRAINT account_hold_sources_created_time_check CHECK(
  isfinite(created_at) AND created_at>='2000-01-01 00:00:00+00'::timestamptz
  AND created_at<'10000-01-01 00:00:00+00'::timestamptz
  AND created_at=date_trunc('milliseconds',created_at));
ALTER TABLE account_holds ADD CONSTRAINT account_holds_time_check CHECK(
  isfinite(created_at) AND (released_at IS NULL OR isfinite(released_at))
  AND created_at>='2000-01-01 00:00:00+00'::timestamptz
  AND created_at<'10000-01-01 00:00:00+00'::timestamptz
  AND (released_at IS NULL OR (released_at>='2000-01-01 00:00:00+00'::timestamptz
    AND released_at<'10000-01-01 00:00:00+00'::timestamptz))
  AND created_at=date_trunc('milliseconds',created_at)
  AND (released_at IS NULL OR released_at=date_trunc('milliseconds',released_at)));
ALTER TABLE seat_invitations ADD CONSTRAINT seat_invitations_time_check CHECK(
  isfinite(created_at) AND isfinite(expires_at)
  AND created_at>='2000-01-01 00:00:00+00'::timestamptz
  AND expires_at<'10000-01-01 00:00:00+00'::timestamptz
  AND created_at=date_trunc('milliseconds',created_at)
  AND expires_at=date_trunc('milliseconds',expires_at));
ALTER TABLE seat_invitation_token_generations ADD CONSTRAINT seat_invitation_tokens_commercial_time_check CHECK(
  isfinite(created_at) AND isfinite(expires_at)
  AND (consumed_at IS NULL OR isfinite(consumed_at))
  AND (superseded_at IS NULL OR isfinite(superseded_at))
  AND created_at>='2000-01-01 00:00:00+00'::timestamptz
  AND expires_at<'10000-01-01 00:00:00+00'::timestamptz
  AND created_at=date_trunc('milliseconds',created_at)
  AND expires_at=date_trunc('milliseconds',expires_at)
  AND (consumed_at IS NULL OR (consumed_at>='2000-01-01 00:00:00+00'::timestamptz
    AND consumed_at<'10000-01-01 00:00:00+00'::timestamptz
    AND consumed_at=date_trunc('milliseconds',consumed_at)))
  AND (superseded_at IS NULL OR (superseded_at>='2000-01-01 00:00:00+00'::timestamptz
    AND superseded_at<'10000-01-01 00:00:00+00'::timestamptz
    AND superseded_at=date_trunc('milliseconds',superseded_at))));
ALTER TABLE seat_reservations ADD CONSTRAINT seat_reservations_time_check CHECK(
  isfinite(created_at) AND isfinite(updated_at)
  AND (expires_at IS NULL OR isfinite(expires_at))
  AND created_at>='2000-01-01 00:00:00+00'::timestamptz
  AND created_at<'10000-01-01 00:00:00+00'::timestamptz
  AND updated_at>='2000-01-01 00:00:00+00'::timestamptz
  AND updated_at<'10000-01-01 00:00:00+00'::timestamptz
  AND updated_at>=created_at
  AND created_at=date_trunc('milliseconds',created_at)
  AND updated_at=date_trunc('milliseconds',updated_at)
  AND (expires_at IS NULL OR (expires_at>='2000-01-01 00:00:00+00'::timestamptz
    AND expires_at<'10000-01-01 00:00:00+00'::timestamptz
    AND expires_at=date_trunc('milliseconds',expires_at))));
ALTER TABLE access_decision_audit ADD CONSTRAINT access_decision_audit_time_check CHECK(
  isfinite(occurred_at)
  AND occurred_at>='2000-01-01 00:00:00+00'::timestamptz
  AND occurred_at<'10000-01-01 00:00:00+00'::timestamptz
  AND occurred_at=date_trunc('milliseconds',occurred_at));
ALTER TABLE entitlement_commands ADD CONSTRAINT entitlement_commands_time_check CHECK(
  isfinite(occurred_at) AND (completed_at IS NULL OR isfinite(completed_at))
  AND occurred_at>='2000-01-01 00:00:00+00'::timestamptz
  AND occurred_at<'10000-01-01 00:00:00+00'::timestamptz
  AND occurred_at=date_trunc('milliseconds',occurred_at)
  AND (completed_at IS NULL OR (completed_at>='2000-01-01 00:00:00+00'::timestamptz
    AND completed_at<'10000-01-01 00:00:00+00'::timestamptz
    AND completed_at=date_trunc('milliseconds',completed_at))));
--> statement-breakpoint
CREATE FUNCTION syntholo_guard_owner_established_at() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='INSERT' AND NEW.owner_established_at IS NOT NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_OWNER_ESTABLISHMENT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF OLD.owner_established_at IS NOT NULL
    AND NEW.owner_established_at IS DISTINCT FROM OLD.owner_established_at THEN
    RAISE EXCEPTION 'SYNTHOLO_OWNER_ESTABLISHMENT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF OLD.owner_established_at IS NULL AND NEW.owner_established_at IS NOT NULL
  THEN
    IF current_setting('app.owner_claim_transition',true) IS DISTINCT FROM
        'syntholo-owner-claim-v1' THEN
      RAISE EXCEPTION 'SYNTHOLO_OWNER_ESTABLISHMENT_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    PERFORM syntholo_attest_runtime_capability('syntholo_system_api');
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_guard_owner_established_at() FROM PUBLIC;
CREATE TRIGGER accounts_owner_established_insert_guard
  BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION syntholo_guard_owner_established_at();
CREATE TRIGGER accounts_owner_established_update_guard
  BEFORE UPDATE OF owner_established_at ON accounts
  FOR EACH ROW EXECUTE FUNCTION syntholo_guard_owner_established_at();
ALTER TABLE accounts ENABLE ALWAYS TRIGGER accounts_owner_established_insert_guard;
ALTER TABLE accounts ENABLE ALWAYS TRIGGER accounts_owner_established_update_guard;
--> statement-breakpoint
CREATE FUNCTION syntholo_prevent_identity_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF (TG_TABLE_NAME='entitlement_grants'
      AND current_setting('app.grant_interval_transition',true)
        ='syntholo-grant-interval-v1'
      AND to_jsonb(NEW) - ARRAY['status','updated_at','ends_at']
        IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','updated_at','ends_at'])
    OR ((TG_TABLE_NAME<>'entitlement_grants'
        OR current_setting('app.grant_interval_transition',true)
          IS DISTINCT FROM 'syntholo-grant-interval-v1')
      AND to_jsonb(NEW) - ARRAY['status','updated_at','released_at','consumed_at','superseded_at','state','membership_id','expires_at','role']
        IS DISTINCT FROM
        to_jsonb(OLD) - ARRAY['status','updated_at','released_at','consumed_at','superseded_at','state','membership_id','expires_at','role']) THEN
    RAISE EXCEPTION 'SYNTHOLO_IMMUTABLE_IDENTITY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_prevent_identity_update() FROM PUBLIC;
CREATE TRIGGER entitlement_sources_identity_immutable BEFORE UPDATE ON entitlement_sources
  FOR EACH ROW EXECUTE FUNCTION syntholo_prevent_identity_update();
CREATE TRIGGER entitlement_grants_identity_immutable BEFORE UPDATE ON entitlement_grants
  FOR EACH ROW EXECUTE FUNCTION syntholo_prevent_identity_update();
CREATE TRIGGER account_hold_sources_identity_immutable BEFORE UPDATE ON account_hold_sources
  FOR EACH ROW EXECUTE FUNCTION syntholo_prevent_identity_update();
CREATE TRIGGER account_holds_identity_immutable BEFORE UPDATE ON account_holds
  FOR EACH ROW EXECUTE FUNCTION syntholo_prevent_identity_update();
CREATE TRIGGER seat_reservations_identity_immutable BEFORE UPDATE ON seat_reservations
  FOR EACH ROW EXECUTE FUNCTION syntholo_prevent_identity_update();
CREATE FUNCTION syntholo_guard_business_os_setup_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF (NEW.source_registry_id,NEW.account_id,NEW.reconciliation_id,NEW.created_at)
      IS DISTINCT FROM
      (OLD.source_registry_id,OLD.account_id,OLD.reconciliation_id,OLD.created_at)
    OR NOT ((OLD.status='paid' AND NEW.status IN ('refunded','dispute_lost'))
      OR (OLD.status='paid_reconciliation'
        AND NEW.status IN ('paid','refunded','dispute_lost')))
    OR NEW.updated_at<OLD.updated_at
    OR current_setting('app.business_os_setup_transition',true)
      IS DISTINCT FROM 'syntholo-business-os-setup-v1' THEN
    RAISE EXCEPTION 'SYNTHOLO_BUSINESS_OS_SETUP_TRANSITION_INVALID'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_guard_business_os_setup_receipt() FROM PUBLIC;
CREATE TRIGGER business_os_setup_receipts_transition_guard
  BEFORE UPDATE ON business_os_setup_receipts
  FOR EACH ROW EXECUTE FUNCTION syntholo_guard_business_os_setup_receipt();
CREATE FUNCTION syntholo_guard_commerce_fulfillment_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF (NEW.source_registry_id,NEW.account_id,NEW.reconciliation_id,
      NEW.starts_at,NEW.ends_at,NEW.created_at)
      IS DISTINCT FROM
      (OLD.source_registry_id,OLD.account_id,OLD.reconciliation_id,
      OLD.starts_at,OLD.ends_at,OLD.created_at)
    OR NOT ((OLD.status='reconciliation'
        AND NEW.status IN ('fulfilled','cancelled','refunded','dispute_lost'))
      OR (OLD.status='fulfilled'
        AND NEW.status IN ('cancelled','refunded','dispute_lost')))
    OR NEW.updated_at<OLD.updated_at
    OR current_setting('app.commerce_fulfillment_transition',true)
      IS DISTINCT FROM 'syntholo-commerce-fulfillment-v1' THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMERCE_FULFILLMENT_TRANSITION_INVALID'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_guard_commerce_fulfillment_receipt() FROM PUBLIC;
CREATE TRIGGER commerce_fulfillment_receipts_transition_guard
  BEFORE UPDATE ON commerce_fulfillment_receipts
  FOR EACH ROW EXECUTE FUNCTION syntholo_guard_commerce_fulfillment_receipt();
CREATE FUNCTION syntholo_guard_commerce_reconciliation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.command_kind,NEW.source_kind,NEW.source_id,
      NEW.request_fingerprint,NEW.reason_code,NEW.target_source_registry_id,
      NEW.expected_paid_through_at,NEW.review_due_at,NEW.created_at)
      IS DISTINCT FROM
      (OLD.id,OLD.account_id,OLD.command_kind,OLD.source_kind,OLD.source_id,
      OLD.request_fingerprint,OLD.reason_code,OLD.target_source_registry_id,
      OLD.expected_paid_through_at,OLD.review_due_at,OLD.created_at)
    OR NOT ((OLD.status='open' AND NEW.status IN ('claimed',
          'resolved_fulfilled','resolved_refund','resolved_manual'))
      OR (OLD.status='claimed' AND NEW.status IN (
          'resolved_fulfilled','resolved_refund','resolved_manual')))
    OR NEW.updated_at<OLD.updated_at
    OR current_setting('app.commerce_reconciliation_transition',true)
      IS DISTINCT FROM 'syntholo-commerce-reconciliation-v1' THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMERCE_RECONCILIATION_TRANSITION_INVALID'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_guard_commerce_reconciliation() FROM PUBLIC;
CREATE TRIGGER commerce_reconciliations_transition_guard
  BEFORE UPDATE ON commerce_reconciliations
  FOR EACH ROW EXECUTE FUNCTION syntholo_guard_commerce_reconciliation();
--> statement-breakpoint
CREATE FUNCTION syntholo_guard_grant_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF OLD.status IN ('refunded','revoked')
    OR NOT ((OLD.status='active' AND NEW.status IN ('grace','expired','refunded','revoked'))
      OR (OLD.status='grace' AND NEW.status IN ('active','expired','refunded','revoked'))
      OR (OLD.status='expired' AND NEW.status IN ('refunded','revoked')))
    OR ((OLD.status='active' AND NEW.status='grace')
      AND (OLD.source_kind<>'subscription' OR OLD.ends_at IS NULL))
  THEN RAISE EXCEPTION 'SYNTHOLO_GRANT_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$fn$;
CREATE FUNCTION syntholo_guard_hold_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
    OR NEW.released_at<OLD.created_at THEN
    RAISE EXCEPTION 'SYNTHOLO_HOLD_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE FUNCTION syntholo_guard_seat_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state NOT IN ('pending','active') THEN
      RAISE EXCEPTION 'SYNTHOLO_SEAT_TRANSITION_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state=OLD.state THEN
    IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
      OR NEW.slot<>OLD.slot OR NEW.source_registry_id<>OLD.source_registry_id THEN
      RAISE EXCEPTION 'SYNTHOLO_SEAT_HISTORY_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('expired','revoked') OR NOT (
    (OLD.state='pending' AND NEW.state IN ('active','expired','revoked'))
    OR (OLD.state='active' AND NEW.state='revoked')) THEN
    RAISE EXCEPTION 'SYNTHOLO_SEAT_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.slot<>OLD.slot OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
    OR NEW.source_registry_id<>OLD.source_registry_id
    OR (NEW.state IN ('expired','revoked') AND OLD.state='pending'
      AND (NEW.membership_id IS NOT NULL OR NEW.expires_at IS DISTINCT FROM OLD.expires_at))
    OR (OLD.state='active' AND (NEW.membership_id IS DISTINCT FROM OLD.membership_id
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at)) THEN
    RAISE EXCEPTION 'SYNTHOLO_SEAT_HISTORY_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_guard_grant_transition(),syntholo_guard_hold_transition(),syntholo_guard_seat_transition() FROM PUBLIC;
CREATE TRIGGER entitlement_grants_transition BEFORE UPDATE OF status ON entitlement_grants
  FOR EACH ROW WHEN(OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION syntholo_guard_grant_transition();
CREATE TRIGGER account_holds_transition BEFORE UPDATE OF released_at ON account_holds
  FOR EACH ROW WHEN(OLD.released_at IS DISTINCT FROM NEW.released_at) EXECUTE FUNCTION syntholo_guard_hold_transition();
CREATE TRIGGER seat_reservations_transition BEFORE INSERT OR UPDATE ON seat_reservations
  FOR EACH ROW EXECUTE FUNCTION syntholo_guard_seat_transition();
--> statement-breakpoint
CREATE FUNCTION syntholo_validate_product_source(p_source uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE s entitlement_sources%ROWTYPE; n integer; ok boolean;
DECLARE v_receipt_status text; v_grant_status text;
BEGIN
  SELECT * INTO s FROM entitlement_sources WHERE id=p_source;
  IF NOT FOUND THEN RETURN; END IF;
  IF s.source_kind='administrative' THEN
    IF EXISTS(SELECT 1 FROM administrative_grant_restorations
        WHERE new_source_registry_id=s.id) THEN
      IF NOT EXISTS(
        SELECT 1 FROM administrative_grant_restorations r
        JOIN entitlement_grants old_grant ON old_grant.id=r.terminal_grant_id
          AND old_grant.account_id=r.account_id
        JOIN entitlement_grants new_grant
          ON new_grant.source_registry_id=r.new_source_registry_id
          AND new_grant.account_id=r.account_id
        WHERE r.new_source_registry_id=s.id
          AND old_grant.source_kind='administrative'
          AND old_grant.status IN ('refunded','revoked')
          AND new_grant.source_kind='administrative'
          AND new_grant.status='active'
          AND new_grant.capability=old_grant.capability
          AND new_grant.capability<>'business_os'
          AND (SELECT count(*) FROM entitlement_grants g
            WHERE g.source_registry_id=s.id)=1
      ) THEN
        RAISE EXCEPTION 'SYNTHOLO_ADMINISTRATIVE_RESTORATION_INVALID'
          USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN;
  END IF;
  SELECT count(*), coalesce(bool_and(g.offer_code IS NOT DISTINCT FROM s.offer_code),false)
  INTO n,ok FROM entitlement_grants g WHERE g.source_registry_id=s.id;
  SELECT status INTO v_receipt_status FROM commerce_fulfillment_receipts r
    WHERE r.source_registry_id=s.id AND r.account_id=s.account_id;
  IF v_receipt_status='reconciliation'
    OR (n=0 AND v_receipt_status IN ('cancelled','refunded','dispute_lost')) THEN
    IF n<>0 THEN
      RAISE EXCEPTION 'SYNTHOLO_PRODUCT_BUNDLE_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  IF n>0 AND v_receipt_status IN ('cancelled','refunded','dispute_lost') THEN
    SELECT CASE WHEN min(status)=max(status) THEN min(status) END
      INTO v_grant_status FROM entitlement_grants WHERE source_registry_id=s.id;
    IF (v_receipt_status='refunded'
        AND v_grant_status IS DISTINCT FROM 'refunded'
        AND NOT (v_grant_status='revoked' AND EXISTS(
          SELECT 1 FROM commerce_reconciliations r
          WHERE r.account_id=s.account_id
            AND r.target_source_registry_id=s.id
            AND r.incident_kind='linked_club_cancellation'
            AND r.status='resolved_refund'
            AND r.resolution_code='club_refunded')))
      OR (v_receipt_status='dispute_lost'
        AND v_grant_status IS DISTINCT FROM 'revoked')
      OR (v_receipt_status='cancelled'
        AND v_grant_status IS DISTINCT FROM 'revoked') THEN
      RAISE EXCEPTION 'SYNTHOLO_PRODUCT_BUNDLE_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  IF s.offer_code IN ('self_paced','guided_pilot') THEN
    SELECT n=3 AND ok AND count(*) FILTER(WHERE capability='academy_course')=1
      AND count(*) FILTER(WHERE capability='support')=1
      AND count(*) FILTER(WHERE capability='circle_write')=1
      AND bool_and(source_kind='purchase')
      AND max(ends_at) FILTER(WHERE capability='academy_course') IS NULL
      AND min(starts_at)=max(starts_at)
      AND count(ends_at) FILTER(WHERE capability IN ('support','circle_write'))=2
      AND min(ends_at) FILTER(WHERE capability IN ('support','circle_write'))
          =max(ends_at) FILTER(WHERE capability IN ('support','circle_write'))
      AND min(ends_at) FILTER(WHERE capability IN ('support','circle_write')) IS NOT NULL
      AND min(ends_at) FILTER(WHERE capability IN ('support','circle_write')) =
        (make_timestamptz(
          extract(year from (min(starts_at) at time zone 'UTC'))::int+1,
          extract(month from (min(starts_at) at time zone 'UTC'))::int,
          least(
            extract(day from (min(starts_at) at time zone 'UTC'))::int,
            extract(day from (date_trunc('month',(min(starts_at) at time zone 'UTC'))
              + interval '1 year 1 month -1 day'))::int),
          extract(hour from (min(starts_at) at time zone 'UTC'))::int,
          extract(minute from (min(starts_at) at time zone 'UTC'))::int,
          extract(second from (min(starts_at) at time zone 'UTC')),
          'UTC'))
      AND (
        (bool_and(status='active'))
        OR (bool_and(CASE WHEN capability='academy_course' THEN status='active' ELSE status='expired' END))
        OR bool_and(status='refunded') OR bool_and(status='revoked'))
    INTO ok FROM entitlement_grants WHERE source_registry_id=s.id;
  ELSIF s.offer_code IN ('operator_club_monthly','operator_club_annual') THEN
    SELECT n=3 AND ok AND count(*) FILTER(WHERE capability='support')=1
      AND count(*) FILTER(WHERE capability='circle_write')=1
      AND count(*) FILTER(WHERE capability='operator_club')=1
      AND bool_and(source_kind='subscription') AND min(starts_at)=max(starts_at)
      AND count(ends_at)=3 AND min(ends_at)=max(ends_at) AND min(ends_at) IS NOT NULL
      AND min(status)=max(status)
    INTO ok FROM entitlement_grants WHERE source_registry_id=s.id;
    ok:=ok AND (SELECT count(*)=1 FROM entitlement_grants academy
      JOIN entitlement_grants support ON support.source_registry_id=academy.source_registry_id
        AND support.account_id=academy.account_id AND support.capability='support'
      WHERE academy.source_registry_id=s.academy_source_registry_id
        AND academy.account_id=s.account_id AND academy.capability='academy_course'
        AND academy.source_kind='purchase' AND academy.offer_code IN ('self_paced','guided_pilot')
        AND greatest(support.ends_at,s.created_at)=(
          SELECT min(starts_at) FROM entitlement_grants WHERE source_registry_id=s.id));
  ELSIF s.offer_code='business_os' THEN
    IF s.source_kind='purchase' THEN
      ok:=n=0 AND (SELECT count(*)=1 FROM business_os_setup_receipts r
        WHERE r.source_registry_id=s.id AND r.account_id=s.account_id);
    ELSE
      SELECT n=1 AND ok AND bool_and(capability='business_os')
        AND bool_and(source_kind='subscription') AND count(ends_at)=1
      INTO ok FROM entitlement_grants WHERE source_registry_id=s.id;
    END IF;
  ELSE ok:=false;
  END IF;
  IF NOT coalesce(ok,false) THEN
    RAISE EXCEPTION 'SYNTHOLO_PRODUCT_BUNDLE_INVALID' USING ERRCODE='23514';
  END IF;
END;
$fn$;
CREATE FUNCTION syntholo_product_bundle_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE v_new uuid; v_old uuid;
BEGIN
  v_new:=coalesce((to_jsonb(NEW)->>'source_registry_id')::uuid,
                  (to_jsonb(NEW)->>'new_source_registry_id')::uuid,
                  (to_jsonb(NEW)->>'id')::uuid);
  v_old:=coalesce((to_jsonb(OLD)->>'source_registry_id')::uuid,
                  (to_jsonb(OLD)->>'new_source_registry_id')::uuid,
                  (to_jsonb(OLD)->>'id')::uuid);
  IF v_new IS NOT NULL THEN PERFORM syntholo_validate_product_source(v_new); END IF;
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN
    PERFORM syntholo_validate_product_source(v_old);
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_validate_product_source(uuid),syntholo_product_bundle_constraint() FROM PUBLIC;
ALTER FUNCTION syntholo_validate_product_source(uuid) SECURITY DEFINER;
ALTER FUNCTION syntholo_product_bundle_constraint() SECURITY DEFINER;
CREATE CONSTRAINT TRIGGER entitlement_sources_bundle_valid AFTER INSERT OR UPDATE ON entitlement_sources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION syntholo_product_bundle_constraint();
CREATE CONSTRAINT TRIGGER entitlement_grants_bundle_valid AFTER INSERT OR UPDATE OR DELETE ON entitlement_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION syntholo_product_bundle_constraint();
CREATE CONSTRAINT TRIGGER business_os_setup_receipts_bundle_valid
  AFTER INSERT OR UPDATE ON business_os_setup_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION syntholo_product_bundle_constraint();
CREATE CONSTRAINT TRIGGER commerce_fulfillment_receipts_bundle_valid
  AFTER INSERT OR UPDATE ON commerce_fulfillment_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION syntholo_product_bundle_constraint();
CREATE CONSTRAINT TRIGGER administrative_grant_restorations_valid
  AFTER INSERT OR UPDATE ON administrative_grant_restorations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION syntholo_product_bundle_constraint();
--> statement-breakpoint
CREATE FUNCTION syntholo_validate_owner_and_seat(p_account uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE a accounts%ROWTYPE; owners integer;
BEGIN
  SELECT * INTO a FROM accounts WHERE id=p_account;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO owners FROM memberships
    WHERE account_id=p_account AND role='owner' AND status='active';
  IF a.status='active' AND a.owner_established_at IS NOT NULL AND owners<>1 THEN
    RAISE EXCEPTION 'SYNTHOLO_OWNER_INVARIANT' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    SELECT 1 FROM seat_reservations r
    LEFT JOIN entitlement_grants g ON g.source_registry_id=r.source_registry_id
      AND g.account_id=r.account_id AND g.capability='academy_course'
      AND g.source_kind='purchase' AND g.offer_code IN ('self_paced','guided_pilot')
      AND g.status IN ('active','grace')
    LEFT JOIN memberships m ON m.id=r.membership_id AND m.account_id=r.account_id
    LEFT JOIN seat_invitations i ON i.id=r.invitation_id AND i.account_id=r.account_id
    WHERE r.account_id=p_account AND (
      (r.state IN ('pending','active') AND g.id IS NULL)
      OR (r.state='active' AND (m.id IS NULL OR m.status<>'active'))
      OR (r.state='pending' AND (i.id IS NULL OR r.expires_at<>i.expires_at)))) THEN
    RAISE EXCEPTION 'SYNTHOLO_SEAT_INVARIANT' USING ERRCODE='23514';
  END IF;
  IF a.status='active' AND EXISTS(
      SELECT 1 FROM entitlement_grants g
      WHERE g.account_id=p_account AND g.capability='academy_course'
        AND g.source_kind='purchase'
        AND g.offer_code IN ('self_paced','guided_pilot')
        AND g.status IN ('active','grace')) THEN
    IF EXISTS(SELECT 1 FROM memberships m
      WHERE m.account_id=p_account AND m.status='active'
        AND NOT EXISTS(SELECT 1 FROM seat_reservations r
          WHERE r.account_id=p_account AND r.membership_id=m.id
            AND r.state='active')) THEN
      RAISE EXCEPTION 'SYNTHOLO_ACTIVE_MEMBERSHIP_SEAT_REQUIRED'
        USING ERRCODE='23514';
    END IF;
  ELSIF a.status='active' AND EXISTS(SELECT 1 FROM memberships m
      WHERE m.account_id=p_account AND m.status='active'
        AND m.role='teammate') THEN
    RAISE EXCEPTION 'SYNTHOLO_TEAMMATE_ACADEMY_REQUIRED' USING ERRCODE='23514';
  END IF;
END;
$fn$;
CREATE FUNCTION syntholo_owner_seat_constraint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE v_new uuid; v_old uuid;
BEGIN
  v_new:=coalesce((to_jsonb(NEW)->>'account_id')::uuid,
                  (to_jsonb(NEW)->>'id')::uuid);
  v_old:=coalesce((to_jsonb(OLD)->>'account_id')::uuid,
                  (to_jsonb(OLD)->>'id')::uuid);
  IF v_new IS NOT NULL THEN PERFORM syntholo_validate_owner_and_seat(v_new); END IF;
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN
    PERFORM syntholo_validate_owner_and_seat(v_old);
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_validate_owner_and_seat(uuid),syntholo_owner_seat_constraint() FROM PUBLIC;
ALTER FUNCTION syntholo_validate_owner_and_seat(uuid) SECURITY DEFINER;
ALTER FUNCTION syntholo_owner_seat_constraint() SECURITY DEFINER;
CREATE CONSTRAINT TRIGGER accounts_owner_valid AFTER INSERT OR UPDATE ON accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION syntholo_owner_seat_constraint();
CREATE CONSTRAINT TRIGGER memberships_owner_seat_valid AFTER INSERT OR UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION syntholo_owner_seat_constraint();
CREATE CONSTRAINT TRIGGER seat_reservations_valid AFTER INSERT OR UPDATE OR DELETE ON seat_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION syntholo_owner_seat_constraint();
CREATE CONSTRAINT TRIGGER seat_grant_valid AFTER INSERT OR UPDATE OR DELETE ON entitlement_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION syntholo_owner_seat_constraint();
--> statement-breakpoint
CREATE FUNCTION syntholo_validate_grant_source_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM entitlement_sources s
    WHERE s.id=NEW.source_registry_id AND s.account_id=NEW.account_id
      AND s.source_kind=NEW.source_kind AND s.source_id=NEW.source_id
      AND s.offer_code IS NOT DISTINCT FROM NEW.offer_code) THEN
    RAISE EXCEPTION 'SYNTHOLO_SOURCE_IDENTITY_MISMATCH' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_validate_grant_source_identity() FROM PUBLIC;
CREATE TRIGGER entitlement_grants_source_identity BEFORE INSERT OR UPDATE ON entitlement_grants
  FOR EACH ROW EXECUTE FUNCTION syntholo_validate_grant_source_identity();
--> statement-breakpoint
CREATE FUNCTION syntholo_attest_runtime_capability(p_expected text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE login_state record; capability_state record;
DECLARE reachable_count integer; expected_count integer;
DECLARE membership_options_safe boolean;
BEGIN
  IF p_expected IS NULL OR p_expected NOT IN ('syntholo_member_api','syntholo_staff_api',
    'syntholo_system_api','syntholo_worker') THEN
    RAISE EXCEPTION 'SYNTHOLO_RUNTIME_CAPABILITY_INVALID' USING ERRCODE='42501';
  END IF;
  SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
    rolbypassrls,rolconfig INTO login_state
    FROM pg_roles WHERE rolname=session_user;
  SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
    rolbypassrls,rolconfig INTO capability_state
    FROM pg_roles WHERE rolname=p_expected;
  WITH RECURSIVE memberships AS (
    SELECT am.roleid,am.inherit_option,am.set_option,am.admin_option,
      ARRAY[login_state.oid,am.roleid]::oid[] path
      FROM pg_auth_members am WHERE am.member=login_state.oid
    UNION ALL
    SELECT am.roleid,am.inherit_option,am.set_option,am.admin_option,
      parent.path||am.roleid
      FROM pg_auth_members am JOIN memberships parent ON parent.roleid=am.member
      WHERE NOT am.roleid=ANY(parent.path)
  )
  SELECT count(DISTINCT roleid)::int,
    count(DISTINCT roleid) FILTER(WHERE roleid=capability_state.oid)::int,
    coalesce(bool_and(inherit_option AND NOT set_option AND NOT admin_option),false)
    INTO reachable_count,expected_count,membership_options_safe FROM memberships;
  IF login_state.oid IS NULL OR capability_state.oid IS NULL
    OR NOT login_state.rolcanlogin OR login_state.rolsuper OR login_state.rolcreatedb
    OR login_state.rolcreaterole OR login_state.rolreplication
    OR login_state.rolbypassrls OR login_state.rolconfig IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=login_state.oid)
    OR reachable_count<>1 OR expected_count<>1 OR NOT membership_options_safe
    OR capability_state.rolcanlogin OR capability_state.rolsuper
    OR capability_state.rolcreatedb OR capability_state.rolcreaterole
    OR capability_state.rolreplication OR capability_state.rolbypassrls
    OR capability_state.rolconfig IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=login_state.oid)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=login_state.oid)
    OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=login_state.oid)
    OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=login_state.oid)
    OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=capability_state.oid)
    OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=capability_state.oid)
    OR has_database_privilege(session_user,current_database(),'CREATE')
    OR has_database_privilege(session_user,current_database(),'TEMP')
    OR has_database_privilege(p_expected,current_database(),'CREATE')
    OR has_database_privilege(p_expected,current_database(),'TEMP')
    OR has_schema_privilege(session_user,'public','CREATE')
    OR has_schema_privilege(p_expected,'public','CREATE')
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_namespace n
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_'
        AND ((n.nspname='public' AND (
              NOT has_schema_privilege(p_expected,n.oid,'USAGE')
              OR has_schema_privilege(p_expected,n.oid,'CREATE')))
          OR (n.nspname<>'public' AND (
              has_schema_privilege(p_expected,n.oid,'USAGE')
              OR has_schema_privilege(p_expected,n.oid,'CREATE'))))))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
        ('TRUNCATE'),('REFERENCES'),('TRIGGER')) privilege(name)
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_'
        AND c.relkind IN ('r','p','v','m','f')
        AND has_table_privilege(p_expected,c.oid,privilege.name)
        AND NOT(n.nspname='public'
          AND c.relname IN ('audit_events','outbox_events')
          AND privilege.name='INSERT')))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES'))
        privilege(name)
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_'
        AND c.relkind IN ('r','p','v','m','f')
        AND has_any_column_privilege(p_expected,c.oid,privilege.name)
        AND NOT(n.nspname='public'
          AND c.relname IN ('audit_events','outbox_events')
          AND privilege.name='INSERT')))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_'
        AND has_function_privilege(p_expected,p.oid,'EXECUTE')
        AND (n.nspname<>'public' OR p.oid::regprocedure::text NOT IN (
          'syntholo_business_os_cancelled(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_payment_failed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_payment_recovered(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_renewed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_cancelled(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_payment_failed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_payment_recovered(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_establish_owner(uuid,uuid,text,text,text,timestamp with time zone)',
          'syntholo_expire_business_os(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_club(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_included_support(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_invitation(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_fulfill_product(uuid,uuid,text,text,text,text,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
          'syntholo_lock_scoped_system_account(uuid)',
          'syntholo_open_dispute(uuid,uuid,text,text,uuid,timestamp with time zone)',
          'syntholo_record_business_os_setup_purchase(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone)',
          'syntholo_record_access_decision(uuid,uuid,text,boolean,text,uuid[],integer,text,timestamp with time zone)',
          'syntholo_redeem_invitation(uuid,uuid,text,bytea,text,text,timestamp with time zone)',
          'syntholo_refund_product(uuid,uuid,text,uuid,text,timestamp with time zone)',
          'syntholo_resolve_dispute(uuid,uuid,text,uuid,text,timestamp with time zone)'
        ))))
  THEN
    RAISE EXCEPTION 'SYNTHOLO_RUNTIME_CAPABILITY_INVALID' USING ERRCODE='42501';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_attest_runtime_capability(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION syntholo_lock_entitlement_graph(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'syntholo-entitlement-account:'||p_account::text,0));
  PERFORM a.id FROM accounts a WHERE a.id=p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SYNTHOLO_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  PERFORM mi.id FROM member_identities mi WHERE mi.account_id=p_account
    ORDER BY mi.id FOR UPDATE;
  PERFORM m.id FROM memberships m WHERE m.account_id=p_account
    ORDER BY m.id FOR UPDATE;
  PERFORM s.id FROM entitlement_sources s WHERE s.account_id=p_account
    ORDER BY s.id FOR UPDATE;
  PERFORM r.source_registry_id FROM business_os_setup_receipts r
    WHERE r.account_id=p_account ORDER BY r.source_registry_id FOR UPDATE;
  PERFORM r.source_registry_id FROM commerce_fulfillment_receipts r
    WHERE r.account_id=p_account ORDER BY r.source_registry_id FOR UPDATE;
  PERFORM r.id FROM commerce_reconciliations r
    WHERE r.account_id=p_account ORDER BY r.id FOR UPDATE;
  PERFORM hs.id FROM account_hold_sources hs WHERE hs.account_id=p_account
    ORDER BY hs.id FOR UPDATE;
  PERFORM g.id FROM entitlement_grants g WHERE g.account_id=p_account
    ORDER BY g.id FOR UPDATE;
  PERFORM r.new_source_registry_id FROM administrative_grant_restorations r
    WHERE r.account_id=p_account ORDER BY r.new_source_registry_id FOR UPDATE;
  PERFORM c.source_registry_id FROM club_subscription_cancellations c
    WHERE c.account_id=p_account ORDER BY c.source_registry_id FOR UPDATE;
  PERFORM c.source_registry_id FROM business_os_subscription_cancellations c
    WHERE c.account_id=p_account ORDER BY c.source_registry_id FOR UPDATE;
  PERFORM h.id FROM account_holds h WHERE h.account_id=p_account
    ORDER BY h.id FOR UPDATE;
  PERFORM i.id FROM seat_invitations i WHERE i.account_id=p_account
    ORDER BY i.id FOR UPDATE;
  PERFORM t.id FROM seat_invitation_token_generations t WHERE t.account_id=p_account
    ORDER BY t.id FOR UPDATE;
  PERFORM r.id FROM seat_reservations r WHERE r.account_id=p_account
    ORDER BY r.id FOR UPDATE;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_lock_entitlement_graph(uuid) FROM PUBLIC;

CREATE FUNCTION syntholo_begin_entitlement_command(
  p_account uuid,p_command uuid,p_kind text,p_input_hash text,p_now timestamptz,
  p_capability text)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE existing entitlement_commands%ROWTYPE; inserted integer;
DECLARE v_actor_type text:=current_setting('app.actor_kind',true);
DECLARE v_actor_id text:=current_setting('app.actor_id',true);
DECLARE v_correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
BEGIN
  PERFORM syntholo_attest_runtime_capability(p_capability);
  IF p_account IS NULL OR p_command IS NULL OR p_kind IS NULL
    OR p_input_hash IS NULL OR p_now IS NULL OR p_capability IS NULL
    OR nullif(current_setting('app.account_id',true),'')::uuid IS DISTINCT FROM p_account
    OR v_actor_id IS NULL OR v_actor_id=''
    OR v_actor_type NOT IN ('member','staff','system')
    OR v_correlation IS NULL OR p_input_hash!~'^[0-9a-f]{64}$'
    OR NOT isfinite(p_now)
    OR p_now<'2000-01-01 00:00:00+00'::timestamptz
    OR p_now>='10000-01-01 00:00:00+00'::timestamptz
    OR p_now<>date_trunc('milliseconds',p_now)
  THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMAND_CONTEXT_INVALID' USING ERRCODE='42501';
  END IF;
  INSERT INTO entitlement_commands(command_id,account_id,command_kind,actor_type,
    actor_id,first_correlation_id,input_hash,occurred_at)
  VALUES(p_command,p_account,p_kind,v_actor_type,v_actor_id,v_correlation,
    p_input_hash,p_now)
  ON CONFLICT(command_id) DO NOTHING;
  GET DIAGNOSTICS inserted=ROW_COUNT;
  IF inserted=1 THEN
    replayed:=false; outcome:=null; result:=null; RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO existing FROM entitlement_commands c
    WHERE c.command_id=p_command FOR SHARE;
  IF NOT FOUND OR existing.account_id<>p_account OR existing.command_kind<>p_kind
    OR existing.actor_type<>v_actor_type OR existing.actor_id<>v_actor_id
    OR existing.input_hash<>p_input_hash OR existing.outcome IS NULL
  THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMAND_CONFLICT' USING ERRCODE='23505';
  END IF;
  replayed:=true; outcome:=existing.outcome; result:=existing.result;
  RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_begin_entitlement_command(uuid,uuid,text,text,timestamptz,text) FROM PUBLIC;

CREATE FUNCTION syntholo_complete_entitlement_command(
  p_command uuid,p_outcome text,p_result jsonb,p_now timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF p_command IS NULL OR p_outcome IS NULL OR p_result IS NULL OR p_now IS NULL
    OR p_outcome NOT IN ('applied','denied') OR jsonb_typeof(p_result)<>'object'
    OR octet_length(p_result::text)>16384 OR p_now<>date_trunc('milliseconds',p_now)
  THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMAND_RESULT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.entitlement_command_completion','syntholo-command-v1',true);
  UPDATE entitlement_commands SET outcome=p_outcome,result=p_result,completed_at=p_now
    WHERE command_id=p_command AND outcome IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMAND_COMPLETION_INVALID' USING ERRCODE='23514';
  END IF;
  PERFORM set_config('app.entitlement_command_completion','',true);
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_complete_entitlement_command(uuid,text,jsonb,timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION syntholo_lock_scoped_system_account(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  PERFORM syntholo_attest_runtime_capability('syntholo_system_api');
  IF current_setting('app.actor_kind',true)<>'system'
    OR nullif(current_setting('app.actor_id',true),'') IS NULL
    OR nullif(current_setting('app.account_id',true),'')::uuid IS DISTINCT FROM p_account
    OR nullif(current_setting('app.correlation_id',true),'')::uuid IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_SYSTEM_CONTEXT_INVALID' USING ERRCODE='42501';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  PERFORM 1 FROM accounts WHERE id=p_account AND status='active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SYNTHOLO_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_lock_scoped_system_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_lock_scoped_system_account(uuid)
  TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION syntholo_member_entitlement_snapshot(
  p_account uuid,p_membership uuid,p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE snapshot jsonb;
BEGIN
  PERFORM syntholo_attest_runtime_capability('syntholo_member_api');
  IF current_setting('transaction_isolation')<>'repeatable read'
    OR current_setting('transaction_read_only')<>'on'
    OR current_setting('app.actor_kind',true)<>'member'
    OR nullif(current_setting('app.account_id',true),'')::uuid IS DISTINCT FROM p_account
    OR nullif(current_setting('app.membership_id',true),'')::uuid IS DISTINCT FROM p_membership
    OR nullif(current_setting('app.actor_id',true),'')::uuid IS DISTINCT FROM p_actor
    OR NOT EXISTS(
      SELECT 1 FROM accounts a
      JOIN memberships m ON m.account_id=a.id
      JOIN member_identities mi ON mi.id=m.member_identity_id
        AND mi.account_id=m.account_id
      WHERE a.id=p_account AND a.status='active'
        AND m.id=p_membership AND m.status='active'
        AND mi.id=p_actor)
  THEN
    RAISE EXCEPTION 'SYNTHOLO_MEMBER_ACCESS_UNAVAILABLE' USING ERRCODE='P0002';
  END IF;

  SELECT jsonb_build_object(
    'grants',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',g.id,'accountId',g.account_id,'capability',g.capability,
      'status',g.status,'sourceKind',g.source_kind,
      'sourceId',g.source_registry_id::text,'offerCode',g.offer_code,
      'academySourceId',s.academy_source_registry_id::text,
      'sourceCreatedAt',s.created_at,
      'startsAt',g.starts_at,'endsAt',g.ends_at) ORDER BY g.id)
      FROM entitlement_grants g
      JOIN entitlement_sources s ON s.id=g.source_registry_id
        AND s.account_id=g.account_id
      WHERE g.account_id=p_account),'[]'::jsonb),
    'holds',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',h.id,'accountId',h.account_id,'kind',h.kind,
      'sourceKind',hs.source_kind,'sourceId',hs.source_id,
      'createdAt',h.created_at,'releasedAt',h.released_at) ORDER BY h.id)
      FROM account_holds h
      JOIN account_hold_sources hs ON hs.id=h.source_registry_id
        AND hs.account_id=h.account_id
      WHERE h.account_id=p_account),'[]'::jsonb),
    'seats',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',r.id,'accountId',r.account_id,'slot',r.slot,
      'sourceId',r.source_registry_id::text,'state',r.state,
      'membershipId',r.membership_id,'invitationId',r.invitation_id,
      'expiresAt',r.expires_at) ORDER BY r.id)
      FROM seat_reservations r WHERE r.account_id=p_account),'[]'::jsonb)
  ) INTO snapshot;
  RETURN snapshot;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_member_entitlement_snapshot(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_member_entitlement_snapshot(uuid,uuid,uuid)
  TO syntholo_member_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION syntholo_record_access_decision(
  p_account uuid,p_command uuid,p_check text,p_allowed boolean,p_reason text,
  p_sources uuid[],p_snapshot_version integer,p_snapshot_hash text,p_occurred timestamptz)
RETURNS TABLE(id uuid,allowed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_actor_type text:=current_setting('app.actor_kind',true);
DECLARE v_actor_id text:=current_setting('app.actor_id',true);
DECLARE v_account uuid:=nullif(current_setting('app.account_id',true),'')::uuid;
DECLARE v_correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
DECLARE existing access_decision_audit%ROWTYPE;
DECLARE member_session boolean:=pg_has_role(session_user,'syntholo_member_api','USAGE');
DECLARE staff_session boolean:=pg_has_role(session_user,'syntholo_staff_api','USAGE');
DECLARE system_session boolean:=pg_has_role(session_user,'syntholo_system_api','USAGE');
BEGIN
  PERFORM syntholo_attest_runtime_capability(CASE v_actor_type
    WHEN 'member' THEN 'syntholo_member_api'
    WHEN 'staff' THEN 'syntholo_staff_api'
    WHEN 'system' THEN 'syntholo_system_api'
    ELSE 'invalid' END);
  IF p_account IS NULL OR p_command IS NULL OR p_check IS NULL
    OR p_allowed IS NULL OR p_reason IS NULL OR p_sources IS NULL
    OR p_occurred IS NULL
    OR v_actor_type NOT IN ('member','staff','system') OR v_actor_id IS NULL
    OR (member_session::int+staff_session::int+system_session::int)<>1
    OR (member_session AND v_actor_type<>'member')
    OR (staff_session AND v_actor_type<>'staff')
    OR (system_session AND v_actor_type<>'system')
    OR v_account IS DISTINCT FROM p_account OR v_correlation IS NULL
    OR p_occurred<>date_trunc('milliseconds',p_occurred)
    OR p_sources IS DISTINCT FROM (SELECT coalesce(array_agg(x ORDER BY x),'{}'::uuid[])
      FROM (SELECT DISTINCT unnest(p_sources) x) q)
    OR (p_snapshot_version IS NULL)<>(p_snapshot_hash IS NULL)
    OR (p_snapshot_version IS NOT NULL AND (p_snapshot_version<>1 OR p_snapshot_hash!~'^[0-9a-f]{64}$'))
  THEN RAISE EXCEPTION 'SYNTHOLO_ACCESS_DECISION_INVALID' USING ERRCODE='42501'; END IF;
  INSERT INTO access_decision_audit(account_id,actor_type,actor_id,correlation_id,
    command_id,check_kind,allowed,reason_code,source_grant_ids,snapshot_version,
    snapshot_hash,occurred_at)
  VALUES(p_account,v_actor_type,v_actor_id,v_correlation,p_command,p_check,
    p_allowed,p_reason,p_sources,p_snapshot_version,p_snapshot_hash,p_occurred)
  ON CONFLICT(account_id,command_id,check_kind) DO NOTHING
  RETURNING access_decision_audit.id,access_decision_audit.allowed INTO id,allowed;
  IF FOUND THEN RETURN NEXT; RETURN; END IF;
  SELECT * INTO existing FROM access_decision_audit WHERE account_id=p_account
    AND command_id=p_command AND check_kind=p_check FOR SHARE;
  IF existing.actor_type=v_actor_type AND existing.actor_id=v_actor_id
    AND existing.allowed=p_allowed
    AND existing.reason_code=p_reason AND existing.source_grant_ids=p_sources
    AND existing.snapshot_version IS NOT DISTINCT FROM p_snapshot_version
    AND existing.snapshot_hash IS NOT DISTINCT FROM p_snapshot_hash THEN
    id:=existing.id; allowed:=existing.allowed; RETURN NEXT; RETURN;
  END IF;
  RAISE EXCEPTION 'SYNTHOLO_ACCESS_DECISION_CONFLICT' USING ERRCODE='23505';
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_record_access_decision(uuid,uuid,text,boolean,text,uuid[],integer,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_record_access_decision(uuid,uuid,text,boolean,text,uuid[],integer,text,timestamptz)
  TO syntholo_member_api,syntholo_staff_api,syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION syntholo_finish_entitlement_command(
  p_account uuid,p_command uuid,p_kind text,p_outcome text,p_result jsonb,
  p_check text,p_reason text,p_sources uuid[],p_now timestamptz,
  p_operator_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_actor_type text:=current_setting('app.actor_kind',true);
DECLARE v_actor_id text:=current_setting('app.actor_id',true);
DECLARE v_correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
DECLARE v_payload jsonb:=jsonb_build_object(
  'commandKind',p_kind,'outcome',p_outcome,'referenceId',p_command::text,
  'reconciliationRequired',coalesce(
    (p_result->>'reconciliationRequired')::boolean,false),
  'sourceRegistryId',p_result->>'sourceRegistryId',
  'reconciliationId',p_result->>'reconciliationId');
DECLARE v_audit_payload jsonb;
BEGIN
  IF p_operator_reason IS NOT NULL
    AND octet_length(btrim(p_operator_reason)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;
  v_audit_payload:=CASE WHEN p_operator_reason IS NULL THEN v_payload
    ELSE v_payload || jsonb_build_object('operatorReason',btrim(p_operator_reason)) END;
  PERFORM * FROM syntholo_record_access_decision(
    p_account,p_command,p_check,p_outcome='applied',p_reason,p_sources,
    null,null,p_now);
  INSERT INTO audit_events(account_id,actor_type,actor_id,action,target_type,
    target_id,correlation_id,payload,occurred_at)
  VALUES(p_account,v_actor_type,v_actor_id,
    CASE WHEN p_outcome='applied' THEN 'entitlement_command_applied'
      ELSE 'entitlement_command_denied' END,
    'entitlement_command',p_command::text,v_correlation,v_audit_payload,p_now);
  IF p_outcome='applied' THEN
    INSERT INTO outbox_events(event_id,account_id,actor_type,actor_id,
      correlation_id,type,aggregate_id,occurred_at,payload,available_at)
    VALUES(p_command,p_account,v_actor_type,v_actor_id,v_correlation,
      CASE WHEN coalesce(
          (p_result->>'reconciliationRequired')::boolean,false)
        THEN 'entitlements.reconciliation_required.v1'
        ELSE 'entitlements.command_applied.v1' END,
      p_account::text,p_now,jsonb_strip_nulls(v_payload),p_now);
  END IF;
  PERFORM syntholo_complete_entitlement_command(
    p_command,p_outcome,p_result,p_now);
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_finish_entitlement_command(uuid,uuid,text,text,jsonb,text,text,uuid[],timestamptz,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION syntholo_open_commerce_reconciliation(
  p_account uuid,p_command_kind text,p_source_kind text,p_source_id text,
  p_request_fingerprint text,p_reason text,p_incident_kind text,
  p_target_source uuid,p_expected_paid_through timestamptz,
  p_now timestamptz)
RETURNS TABLE(reconciliation_id uuid,reconciliation_status text,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF p_command_kind IS NULL OR p_source_kind IS NULL OR p_source_id IS NULL
    OR p_request_fingerprint IS NULL OR p_reason IS NULL
    OR p_incident_kind IS NULL OR p_now IS NULL
    OR (p_expected_paid_through IS NOT NULL AND (
      NOT isfinite(p_expected_paid_through)
      OR p_expected_paid_through<>date_trunc('milliseconds',p_expected_paid_through)
      OR p_expected_paid_through<'2000-01-01 00:00:00+00'::timestamptz
      OR p_expected_paid_through>='10000-01-01 00:00:00+00'::timestamptz))
    OR p_command_kind NOT IN ('fulfill_product','business_os_setup_paid',
      'open_dispute','resolve_dispute','club_cancelled','business_os_cancelled',
      'refund_product')
    OR octet_length(p_source_kind) NOT BETWEEN 1 AND 64
    OR octet_length(p_source_id) NOT BETWEEN 1 AND 255
    OR p_request_fingerprint!~'^[0-9a-f]{64}$'
    OR p_reason!~'^[A-Z][A-Z0-9_]{0,63}$'
    OR p_incident_kind NOT IN ('parked_paid_receipt','provider_source_collision',
      'linked_academy_refund','linked_club_cancellation')
    OR p_now<>date_trunc('milliseconds',p_now) THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMERCE_RECONCILIATION_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  INSERT INTO commerce_reconciliations(account_id,command_kind,source_kind,
    source_id,request_fingerprint,reason_code,incident_kind,
    target_source_registry_id,expected_paid_through_at,status,
    review_due_at,created_at,updated_at)
  VALUES(p_account,p_command_kind,p_source_kind,p_source_id,
    p_request_fingerprint,p_reason,p_incident_kind,p_target_source,
    p_expected_paid_through,'open',
    p_now+interval '48 hours',p_now,p_now)
  ON CONFLICT(account_id,command_kind,source_kind,source_id,request_fingerprint)
  DO NOTHING
  RETURNING id,status,true
    INTO reconciliation_id,reconciliation_status,created;
  IF reconciliation_id IS NULL THEN
    SELECT id,status,false
      INTO reconciliation_id,reconciliation_status,created
      FROM commerce_reconciliations
      WHERE account_id=p_account AND command_kind=p_command_kind
        AND source_kind=p_source_kind
        AND source_id=p_source_id
        AND request_fingerprint=p_request_fingerprint
        AND reason_code=p_reason
        AND incident_kind=p_incident_kind
        AND target_source_registry_id IS NOT DISTINCT FROM p_target_source
        AND expected_paid_through_at IS NOT DISTINCT FROM p_expected_paid_through;
  END IF;
  IF reconciliation_id IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMERCE_RECONCILIATION_CONFLICT'
      USING ERRCODE='23505';
  END IF;
  RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_open_commerce_reconciliation(
  uuid,text,text,text,text,text,text,uuid,timestamptz,timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION syntholo_member_recent_auth(p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v_authenticated timestamptz;
BEGIN
  BEGIN
    v_authenticated:=nullif(current_setting('app.authenticated_at',true),'')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN v_authenticated IS NOT NULL
    AND v_authenticated>=p_now-interval '300 seconds'
    AND v_authenticated<=p_now+interval '5 seconds';
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_member_recent_auth(timestamptz) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION syntholo_staff_entitlement_authority_reason(p_now timestamptz)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v_permissions jsonb;
DECLARE v_staff_id uuid; v_stored_role text; v_stored_status text;
DECLARE v_stored_permissions text[];
BEGIN
  BEGIN
    v_staff_id:=nullif(current_setting('app.actor_id',true),'')::uuid;
  EXCEPTION WHEN others THEN
    RETURN 'STAFF_ADMIN_REQUIRED';
  END;
  SELECT role,status,permissions
    INTO v_stored_role,v_stored_status,v_stored_permissions
    FROM public.staff_identities WHERE id=v_staff_id;
  IF NOT FOUND OR v_stored_status<>'active' OR v_stored_role<>'admin'
    OR current_setting('app.actor_role',true) IS DISTINCT FROM v_stored_role THEN
    RETURN 'STAFF_ADMIN_REQUIRED';
  END IF;
  BEGIN
    v_permissions:=current_setting('app.actor_permissions',true)::jsonb;
  EXCEPTION WHEN others THEN
    RETURN 'STAFF_PERMISSION_REQUIRED';
  END;
  IF jsonb_typeof(v_permissions)<>'array'
    OR NOT (v_permissions ? 'entitlements:manage')
    OR NOT ('entitlements:manage'=ANY(v_stored_permissions)) THEN
    RETURN 'STAFF_PERMISSION_REQUIRED';
  END IF;
  IF NOT public.syntholo_member_recent_auth(p_now) THEN
    RETURN 'RECENT_AUTH_REQUIRED';
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_staff_entitlement_authority_reason(timestamptz)
  FROM PUBLIC;

CREATE FUNCTION syntholo_list_commerce_reconciliations(
  p_account uuid,p_status text,p_limit integer,p_now timestamptz)
RETURNS TABLE(id uuid,account_id uuid,command_kind text,source_kind text,
  source_id text,reason_code text,incident_kind text,status text,
  review_due_at timestamptz,claimed_at timestamptz,resolved_at timestamptz,
  created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF p_account IS NULL OR p_now IS NULL OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 100
    OR (p_status IS NOT NULL AND p_status NOT IN ('open','claimed')) THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMERCE_RECONCILIATION_QUERY_INVALID'
      USING ERRCODE='22023';
  END IF;
  IF nullif(current_setting('app.account_id',true),'')::uuid IS DISTINCT FROM p_account
    OR syntholo_staff_entitlement_authority_reason(p_now) IS NOT NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT r.id,r.account_id,r.command_kind,r.source_kind,r.source_id,
    r.reason_code,r.incident_kind,r.status,r.review_due_at,r.claimed_at,
    r.resolved_at,r.created_at
    FROM commerce_reconciliations r
    WHERE r.account_id=p_account
      AND ((p_status IS NULL AND r.status IN ('open','claimed'))
        OR r.status=p_status)
    ORDER BY r.review_due_at,r.id LIMIT p_limit;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_list_commerce_reconciliations(
  uuid,text,integer,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_list_commerce_reconciliations(
  uuid,text,integer,timestamptz) TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_staff_administrative_boundary_reason(
  p_account uuid,p_now timestamptz)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_authority text;
BEGIN
  v_authority:=syntholo_staff_entitlement_authority_reason(p_now);
  IF v_authority IS NOT NULL THEN RETURN v_authority; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active') THEN
    RETURN 'ACCOUNT_INACTIVE';
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_staff_administrative_boundary_reason(uuid,timestamptz)
  FROM PUBLIC;

CREATE FUNCTION syntholo_claim_commerce_reconciliation(
  p_account uuid,p_command uuid,p_input_hash text,p_reconciliation uuid,
  p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_reconciliation_id uuid;
DECLARE v_row commerce_reconciliations%ROWTYPE; v_staff uuid;
BEGIN
  IF p_reconciliation IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMERCE_RECONCILIATION_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'claim_commerce_reconciliation',p_input_hash,p_now,
    'syntholo_staff_api');
  IF v_command.replayed THEN
    IF syntholo_staff_entitlement_authority_reason(p_now) IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  v_reason:=syntholo_staff_entitlement_authority_reason(p_now);
  IF v_reason IS NOT NULL THEN
    v_outcome:='denied';
  ELSE
    BEGIN
      v_staff:=nullif(current_setting('app.actor_id',true),'')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_staff:=null;
    END;
    SELECT * INTO v_row FROM commerce_reconciliations
      WHERE id=p_reconciliation AND account_id=p_account FOR UPDATE;
    IF NOT FOUND THEN
      v_outcome:='denied'; v_reason:='COMMERCE_RECONCILIATION_NOT_FOUND';
    ELSIF v_row.status='open' THEN
      PERFORM set_config('app.commerce_reconciliation_transition',
        'syntholo-commerce-reconciliation-v1',true);
      UPDATE commerce_reconciliations SET status='claimed',
        claimed_by_staff_id=v_staff,claimed_at=p_now,updated_at=p_now
        WHERE id=p_reconciliation;
      PERFORM set_config('app.commerce_reconciliation_transition','',true);
      v_outcome:='applied'; v_reason:='COMMERCE_RECONCILIATION_CLAIMED';
    ELSIF v_row.status='claimed' AND v_row.claimed_by_staff_id=v_staff THEN
      v_outcome:='applied'; v_reason:='COMMERCE_RECONCILIATION_ALREADY_CLAIMED';
    ELSIF v_row.status='claimed' THEN
      v_outcome:='denied'; v_reason:='COMMERCE_RECONCILIATION_CLAIMED_BY_OTHER';
    ELSE
      v_outcome:='denied'; v_reason:='COMMERCE_RECONCILIATION_RESOLVED';
    END IF;
  END IF;
  IF v_outcome='applied' THEN
    SELECT * INTO v_row FROM commerce_reconciliations WHERE id=p_reconciliation;
    v_result:=jsonb_build_object('reconciliationId',p_reconciliation,
      'status',v_row.status,'reviewDueAt',v_row.review_due_at,
      'reasonCode',v_reason);
  ELSE
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'claim_commerce_reconciliation',v_outcome,v_result,
    'commerce_reconciliation:claim',v_reason,'{}'::uuid[],p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_claim_commerce_reconciliation(
  uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_claim_commerce_reconciliation(
  uuid,uuid,text,uuid,timestamptz) TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_resolve_commerce_reconciliation(
  p_account uuid,p_command uuid,p_input_hash text,p_reconciliation uuid,
  p_resolution text,p_paid_through timestamptz,p_reason_input text,
  p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_row commerce_reconciliations%ROWTYPE; v_staff uuid; v_status text;
DECLARE v_academy_source uuid; v_hold_source uuid; v_sources uuid[]:='{}';
DECLARE v_club_start timestamptz; v_club_end timestamptz; v_club_status text;
DECLARE v_expected_paid_through timestamptz; v_existing_paid_through timestamptz;
DECLARE v_resolution_code text;
BEGIN
  IF p_reconciliation IS NULL OR p_resolution IS NULL
    OR p_resolution NOT IN ('refund','manual','club_cancelled',
      'club_refunded','abort_refund') OR p_reason_input IS NULL
    OR (p_resolution='club_cancelled' AND (
      p_paid_through IS NULL OR NOT isfinite(p_paid_through)
      OR p_paid_through<>date_trunc('milliseconds',p_paid_through)
      OR p_paid_through<'2000-01-01 00:00:00+00'::timestamptz
      OR p_paid_through>='10000-01-01 00:00:00+00'::timestamptz))
    OR (p_resolution<>'club_cancelled' AND p_paid_through IS NOT NULL)
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMERCE_RECONCILIATION_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'resolve_commerce_reconciliation',p_input_hash,p_now,
    'syntholo_staff_api');
  IF v_command.replayed THEN
    IF syntholo_staff_entitlement_authority_reason(p_now) IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  v_reason:=syntholo_staff_entitlement_authority_reason(p_now);
  IF v_reason IS NOT NULL THEN
    v_outcome:='denied';
  ELSE
    BEGIN
      v_staff:=nullif(current_setting('app.actor_id',true),'')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_staff:=null;
    END;
    SELECT * INTO v_row FROM commerce_reconciliations
      WHERE id=p_reconciliation AND account_id=p_account FOR UPDATE;
    IF NOT FOUND THEN
      v_outcome:='denied'; v_reason:='COMMERCE_RECONCILIATION_NOT_FOUND';
    ELSIF v_row.status<>'claimed' OR v_row.claimed_by_staff_id<>v_staff THEN
      v_outcome:='denied'; v_reason:='COMMERCE_RECONCILIATION_CLAIM_REQUIRED';
    ELSIF v_row.incident_kind='linked_academy_refund' THEN
      IF p_resolution NOT IN ('club_cancelled','club_refunded','abort_refund') THEN
        v_outcome:='denied';
        v_reason:='ACADEMY_REFUND_PROVIDER_DISPOSITION_REQUIRED';
      ELSE
        SELECT academy_source_registry_id INTO v_academy_source
          FROM entitlement_sources
          WHERE id=v_row.target_source_registry_id
            AND account_id=p_account
            AND source_kind='subscription'
            AND offer_code IN ('operator_club_monthly','operator_club_annual');
        SELECT id INTO v_hold_source FROM account_hold_sources
          WHERE account_id=p_account
            AND source_kind='academy_refund_reconciliation'
            AND source_id=p_reconciliation::text
            AND target_source_registry_id=v_row.target_source_registry_id;
        IF v_academy_source IS NULL OR v_hold_source IS NULL
          OR NOT EXISTS(SELECT 1 FROM entitlement_sources
            WHERE id=v_academy_source AND account_id=p_account
              AND source_kind='purchase'
              AND offer_code IN ('self_paced','guided_pilot')) THEN
          v_outcome:='denied';
          v_reason:='ACADEMY_REFUND_RECONCILIATION_INVALID';
        ELSIF p_resolution='club_cancelled' THEN
          SELECT min(starts_at),min(ends_at),min(status)
            INTO v_club_start,v_club_end,v_club_status
            FROM entitlement_grants
            WHERE source_registry_id=v_row.target_source_registry_id
              AND account_id=p_account;
          IF v_club_start IS NULL THEN
            SELECT starts_at,ends_at,status
              INTO v_club_start,v_club_end,v_club_status
              FROM commerce_fulfillment_receipts
              WHERE source_registry_id=v_row.target_source_registry_id
                AND account_id=p_account;
          END IF;
          v_expected_paid_through:=v_row.expected_paid_through_at;
          SELECT paid_through_at INTO v_existing_paid_through
            FROM club_subscription_cancellations
            WHERE source_registry_id=v_row.target_source_registry_id
              AND account_id=p_account;
          IF v_club_start IS NULL OR v_expected_paid_through IS NULL
            OR p_paid_through IS DISTINCT FROM v_expected_paid_through
            OR (v_existing_paid_through IS NOT NULL
              AND v_existing_paid_through<>p_paid_through) THEN
            v_outcome:='denied';
            v_reason:='LINKED_CLUB_CANCELLATION_TERM_INVALID';
          ELSE
            INSERT INTO club_subscription_cancellations(
              source_registry_id,account_id,paid_through_at,created_at)
            VALUES(v_row.target_source_registry_id,p_account,
              p_paid_through,p_now)
            ON CONFLICT(source_registry_id) DO NOTHING;
          END IF;
        END IF;
        IF v_outcome IS NULL AND p_resolution='abort_refund' THEN
          UPDATE account_holds h SET released_at=p_now
            FROM account_hold_sources hs
            WHERE hs.id=h.source_registry_id AND hs.account_id=p_account
              AND hs.source_kind='academy_refund_reconciliation'
              AND hs.target_source_registry_id IN (
                SELECT id FROM entitlement_sources
                WHERE account_id=p_account
                  AND academy_source_registry_id=v_academy_source)
              AND h.released_at IS NULL;
          v_status:='resolved_manual'; v_resolution_code:='abort_refund';
          v_reason:='ACADEMY_REFUND_ABORTED';
        ELSIF v_outcome IS NULL THEN
          PERFORM set_config('app.commerce_fulfillment_transition',
            'syntholo-commerce-fulfillment-v1',true);
          UPDATE commerce_fulfillment_receipts
            SET status=CASE p_resolution WHEN 'club_refunded' THEN 'refunded'
              ELSE 'cancelled' END,updated_at=p_now
            WHERE account_id=p_account
              AND source_registry_id=v_row.target_source_registry_id
              AND status IN ('fulfilled','reconciliation');
          PERFORM set_config('app.commerce_fulfillment_transition','',true);
          UPDATE entitlement_grants SET
            status=CASE p_resolution WHEN 'club_refunded' THEN 'refunded'
              ELSE 'revoked' END,updated_at=p_now
            WHERE account_id=p_account
              AND source_registry_id=v_row.target_source_registry_id
              AND status IN ('active','grace','expired');
          UPDATE account_holds SET released_at=p_now
            WHERE source_registry_id=v_hold_source AND released_at IS NULL;
          v_status:=CASE p_resolution WHEN 'club_refunded'
            THEN 'resolved_refund' ELSE 'resolved_manual' END;
          v_resolution_code:=p_resolution;
          v_reason:='LINKED_CLUB_DISPOSITION_RECORDED';
        END IF;
        IF v_outcome IS NULL THEN
          PERFORM set_config('app.commerce_reconciliation_transition',
            'syntholo-commerce-reconciliation-v1',true);
          UPDATE commerce_reconciliations SET status=CASE p_resolution
              WHEN 'club_refunded' THEN 'resolved_refund'
              ELSE 'resolved_manual' END,
            resolution_code=p_resolution,resolved_at=p_now,updated_at=p_now
            WHERE id=(SELECT reconciliation_id
                FROM commerce_fulfillment_receipts
                WHERE source_registry_id=v_row.target_source_registry_id
                  AND account_id=p_account)
              AND account_id=p_account
              AND incident_kind='parked_paid_receipt'
              AND p_resolution IN ('club_cancelled','club_refunded')
              AND status IN ('open','claimed');
          IF p_resolution='abort_refund' THEN
            UPDATE commerce_reconciliations SET status='resolved_manual',
              resolution_code='abort_refund',resolved_at=p_now,updated_at=p_now
              WHERE account_id=p_account
                AND incident_kind='linked_academy_refund'
                AND target_source_registry_id IN (
                  SELECT id FROM entitlement_sources
                  WHERE account_id=p_account
                    AND academy_source_registry_id=v_academy_source)
                AND status IN ('open','claimed');
          ELSE
            UPDATE commerce_reconciliations SET status=v_status,
              resolution_code=v_resolution_code,resolved_at=p_now,
              updated_at=p_now WHERE id=p_reconciliation;
          END IF;
          PERFORM set_config('app.commerce_reconciliation_transition','',true);
          IF p_resolution<>'abort_refund' AND NOT EXISTS(
              SELECT 1 FROM commerce_reconciliations pending
              JOIN entitlement_sources club
                ON club.id=pending.target_source_registry_id
                AND club.account_id=pending.account_id
              WHERE pending.account_id=p_account
                AND pending.incident_kind='linked_academy_refund'
                AND pending.status IN ('open','claimed')
                AND club.academy_source_registry_id=v_academy_source) THEN
            PERFORM set_config('app.commerce_fulfillment_transition',
              'syntholo-commerce-fulfillment-v1',true);
            UPDATE commerce_fulfillment_receipts
              SET status='refunded',updated_at=p_now
              WHERE account_id=p_account
                AND source_registry_id=v_academy_source
                AND status IN ('fulfilled','reconciliation');
            PERFORM set_config('app.commerce_fulfillment_transition','',true);
            UPDATE entitlement_grants SET status='refunded',updated_at=p_now
              WHERE account_id=p_account AND source_registry_id=v_academy_source
                AND status IN ('active','grace','expired');
            PERFORM syntholo_release_academy_seats(
              p_account,v_academy_source,p_now);
            v_reason:=CASE p_resolution WHEN 'club_refunded'
              THEN 'ACADEMY_AND_LINKED_CLUB_REFUNDED'
              ELSE 'ACADEMY_REFUNDED_LINKED_CLUB_CANCELLED' END;
          END IF;
          SELECT array_agg(id ORDER BY id) INTO v_sources FROM (
            SELECT id FROM entitlement_grants
              WHERE account_id=p_account
                AND source_registry_id IN (
                  v_academy_source,v_row.target_source_registry_id)
            UNION
            SELECT id FROM account_holds WHERE source_registry_id=v_hold_source
          ) evidence;
          v_outcome:='applied';
          v_result:=jsonb_build_object(
            'reconciliationId',p_reconciliation,'status',v_status,
            'providerDisposition',v_resolution_code,'reasonCode',v_reason);
        END IF;
      END IF;
    ELSIF v_row.incident_kind='linked_club_cancellation' THEN
      SELECT id INTO v_hold_source FROM account_hold_sources
        WHERE account_id=p_account
          AND source_kind='club_cancellation_reconciliation'
          AND source_id=p_reconciliation::text
          AND target_source_registry_id=v_row.target_source_registry_id;
      IF p_resolution NOT IN ('club_cancelled','club_refunded') THEN
        v_outcome:='denied';
        v_reason:='LINKED_CLUB_PROVIDER_DISPOSITION_REQUIRED';
      ELSIF v_hold_source IS NULL OR NOT EXISTS(
        SELECT 1 FROM entitlement_sources
        WHERE id=v_row.target_source_registry_id AND account_id=p_account
          AND source_kind='subscription'
          AND offer_code IN ('operator_club_monthly','operator_club_annual')) THEN
        v_outcome:='denied';
        v_reason:='LINKED_CLUB_RECONCILIATION_INVALID';
      ELSIF p_resolution='club_cancelled' THEN
        SELECT min(starts_at),min(ends_at),min(status)
          INTO v_club_start,v_club_end,v_club_status
          FROM entitlement_grants
          WHERE source_registry_id=v_row.target_source_registry_id
            AND account_id=p_account;
        v_expected_paid_through:=v_row.expected_paid_through_at;
        SELECT paid_through_at INTO v_existing_paid_through
          FROM club_subscription_cancellations
          WHERE source_registry_id=v_row.target_source_registry_id
            AND account_id=p_account;
        IF v_expected_paid_through IS NULL
          OR p_paid_through IS DISTINCT FROM v_expected_paid_through
          OR (v_existing_paid_through IS NOT NULL
            AND v_existing_paid_through<>p_paid_through) THEN
          v_outcome:='denied';
          v_reason:='LINKED_CLUB_CANCELLATION_TERM_INVALID';
        ELSE
          INSERT INTO club_subscription_cancellations(
            source_registry_id,account_id,paid_through_at,created_at)
          VALUES(v_row.target_source_registry_id,p_account,p_paid_through,p_now)
          ON CONFLICT(source_registry_id) DO NOTHING;
        END IF;
      END IF;
      IF v_outcome IS NULL THEN
        PERFORM set_config('app.commerce_fulfillment_transition',
          'syntholo-commerce-fulfillment-v1',true);
        UPDATE commerce_fulfillment_receipts SET
          status=CASE p_resolution WHEN 'club_refunded' THEN 'refunded'
            ELSE 'cancelled' END,updated_at=p_now
          WHERE account_id=p_account
            AND source_registry_id=v_row.target_source_registry_id
            AND status IN ('fulfilled','reconciliation');
        PERFORM set_config('app.commerce_fulfillment_transition','',true);
        UPDATE account_holds SET released_at=p_now
          WHERE source_registry_id=v_hold_source AND released_at IS NULL;
        v_status:=CASE p_resolution WHEN 'club_refunded'
          THEN 'resolved_refund' ELSE 'resolved_manual' END;
        PERFORM set_config('app.commerce_reconciliation_transition',
          'syntholo-commerce-reconciliation-v1',true);
        UPDATE commerce_reconciliations SET status=v_status,
          resolution_code=p_resolution,resolved_at=p_now,updated_at=p_now
          WHERE id=(SELECT reconciliation_id
              FROM commerce_fulfillment_receipts
              WHERE source_registry_id=v_row.target_source_registry_id
                AND account_id=p_account)
            AND account_id=p_account
            AND incident_kind='parked_paid_receipt'
            AND status IN ('open','claimed');
        UPDATE commerce_reconciliations SET status=v_status,
          resolution_code=p_resolution,resolved_at=p_now,updated_at=p_now
          WHERE id=p_reconciliation;
        PERFORM set_config('app.commerce_reconciliation_transition','',true);
        SELECT array_agg(id ORDER BY id) INTO v_sources FROM (
          SELECT id FROM entitlement_grants
            WHERE source_registry_id=v_row.target_source_registry_id
          UNION
          SELECT id FROM account_holds WHERE source_registry_id=v_hold_source
        ) evidence;
        v_outcome:='applied';
        v_reason:=CASE p_resolution WHEN 'club_refunded'
          THEN 'LINKED_CLUB_PROVIDER_REFUND_CONFIRMED'
          ELSE 'LINKED_CLUB_PROVIDER_CANCELLATION_CONFIRMED' END;
        v_result:=jsonb_build_object('reconciliationId',p_reconciliation,
          'status',v_status,'providerDisposition',p_resolution,
          'reasonCode',v_reason);
      END IF;
    ELSIF v_row.incident_kind='parked_paid_receipt' AND (
      EXISTS(SELECT 1 FROM commerce_fulfillment_receipts
        WHERE source_registry_id=v_row.target_source_registry_id
          AND account_id=p_account AND status='reconciliation')
      OR EXISTS(SELECT 1 FROM business_os_setup_receipts
        WHERE source_registry_id=v_row.target_source_registry_id
          AND account_id=p_account AND status='paid_reconciliation')) THEN
      v_outcome:='denied'; v_reason:='COMMERCE_SOURCE_COMMAND_REQUIRED';
    ELSE
      IF p_resolution NOT IN ('refund','manual') THEN
        v_outcome:='denied';
        v_reason:='COMMERCE_RECONCILIATION_ACTION_INVALID';
      END IF;
    END IF;
    IF v_outcome IS NULL AND v_result IS NULL THEN
      v_status:=CASE p_resolution WHEN 'refund' THEN 'resolved_refund'
        ELSE 'resolved_manual' END;
      v_resolution_code:=p_resolution;
      PERFORM set_config('app.commerce_reconciliation_transition',
        'syntholo-commerce-reconciliation-v1',true);
      UPDATE commerce_reconciliations SET status=v_status,
        resolution_code=v_resolution_code,resolved_at=p_now,updated_at=p_now
        WHERE id=p_reconciliation;
      PERFORM set_config('app.commerce_reconciliation_transition','',true);
      v_outcome:='applied'; v_reason:=CASE p_resolution
        WHEN 'refund' THEN 'COMMERCE_RECONCILIATION_REFUND_CONFIRMED'
        ELSE 'COMMERCE_RECONCILIATION_MANUALLY_RESOLVED' END;
      v_result:=jsonb_build_object('reconciliationId',p_reconciliation,
        'status',v_status,'reasonCode',v_reason);
    END IF;
  END IF;
  IF v_result IS NULL THEN v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'resolve_commerce_reconciliation',v_outcome,v_result,
    'commerce_reconciliation:resolve',v_reason,coalesce(v_sources,'{}'),
    p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_resolve_commerce_reconciliation(
  uuid,uuid,text,uuid,text,timestamptz,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_resolve_commerce_reconciliation(
  uuid,uuid,text,uuid,text,timestamptz,text,timestamptz)
  TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_grant_administrative(
  p_account uuid,p_command uuid,p_input_hash text,p_capability text,
  p_starts timestamptz,p_ends timestamptz,p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_boundary text; v_source uuid:=gen_random_uuid();
DECLARE v_grant uuid:=gen_random_uuid(); v_sources uuid[]:='{}';
BEGIN
  IF p_capability IS NULL
    OR p_capability NOT IN ('academy_course','support','circle_write','operator_club')
    OR p_starts IS NULL OR NOT isfinite(p_starts)
    OR p_starts<>date_trunc('milliseconds',p_starts)
    OR p_starts<'2000-01-01 00:00:00+00'::timestamptz
    OR p_starts>='10000-01-01 00:00:00+00'::timestamptz
    OR (p_ends IS NOT NULL AND (NOT isfinite(p_ends) OR p_ends<=p_starts
      OR p_ends<>date_trunc('milliseconds',p_ends)
      OR p_ends>='10000-01-01 00:00:00+00'::timestamptz))
    OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_ADMINISTRATIVE_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'grant_administrative',p_input_hash,p_now,
    'syntholo_staff_api');
  v_boundary:=syntholo_staff_administrative_boundary_reason(p_account,p_now);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  END IF;
  IF v_outcome IS NULL THEN
    INSERT INTO entitlement_sources(id,account_id,source_kind,source_id,
      offer_code,academy_source_registry_id,provenance,created_at)
    VALUES(v_source,p_account,'administrative','staff:'||p_command::text,
      null,null,'staff-administrative',p_now);
    INSERT INTO entitlement_grants(id,account_id,source_registry_id,source_kind,
      source_id,offer_code,capability,status,starts_at,ends_at,provenance,
      created_at,updated_at)
    VALUES(v_grant,p_account,v_source,'administrative','staff:'||p_command::text,
      null,p_capability,'active',p_starts,p_ends,'staff-administrative',p_now,p_now);
    v_sources:=ARRAY[v_grant];
    v_outcome:='applied'; v_reason:='ADMINISTRATIVE_GRANT_ALLOWED';
    v_result:=jsonb_build_object('sourceRegistryId',v_source,'grantId',v_grant,
      'capability',p_capability,'reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'grant_administrative',v_outcome,v_result,'administrative:grant',v_reason,
    v_sources,p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_grant_administrative(uuid,uuid,text,text,timestamptz,timestamptz,text,timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_grant_administrative(uuid,uuid,text,text,timestamptz,timestamptz,text,timestamptz)
  TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_revoke_administrative(
  p_account uuid,p_command uuid,p_input_hash text,p_grant uuid,
  p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_boundary text; v_sources uuid[]:='{}';
BEGIN
  IF p_grant IS NULL OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_ADMINISTRATIVE_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'revoke_administrative',p_input_hash,p_now,
    'syntholo_staff_api');
  v_boundary:=syntholo_staff_administrative_boundary_reason(p_account,p_now);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  ELSE
    SELECT ARRAY[g.id] INTO v_sources FROM entitlement_grants g
      WHERE g.id=p_grant AND g.account_id=p_account
        AND g.source_kind='administrative'
        AND g.capability<>'business_os' AND g.status IN ('active','expired');
    IF coalesce(cardinality(v_sources),0)<>1 THEN
      v_outcome:='denied'; v_reason:='ADMINISTRATIVE_GRANT_NOT_REVOCABLE';
      v_sources:='{}';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE entitlement_grants SET status='revoked',updated_at=p_now
      WHERE id=p_grant;
    v_outcome:='applied'; v_reason:='ADMINISTRATIVE_GRANT_REVOKED';
    v_result:=jsonb_build_object('grantId',p_grant,'reasonCode',v_reason);
  ELSE
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'revoke_administrative',v_outcome,v_result,'administrative:revoke',v_reason,
    v_sources,p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_revoke_administrative(uuid,uuid,text,uuid,text,timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_revoke_administrative(uuid,uuid,text,uuid,text,timestamptz)
  TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_restore_administrative(
  p_account uuid,p_command uuid,p_input_hash text,p_terminal_grant uuid,
  p_starts timestamptz,p_ends timestamptz,p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_boundary text; v_source uuid:=gen_random_uuid();
DECLARE v_grant uuid:=gen_random_uuid(); v_capability text; v_sources uuid[]:='{}';
BEGIN
  IF p_terminal_grant IS NULL OR p_starts IS NULL OR NOT isfinite(p_starts)
    OR p_starts<>date_trunc('milliseconds',p_starts)
    OR p_starts<'2000-01-01 00:00:00+00'::timestamptz
    OR p_starts>='10000-01-01 00:00:00+00'::timestamptz
    OR (p_ends IS NOT NULL AND (NOT isfinite(p_ends) OR p_ends<=p_starts
      OR p_ends<>date_trunc('milliseconds',p_ends)
      OR p_ends>='10000-01-01 00:00:00+00'::timestamptz))
    OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_ADMINISTRATIVE_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'restore_administrative',p_input_hash,p_now,
    'syntholo_staff_api');
  v_boundary:=syntholo_staff_administrative_boundary_reason(p_account,p_now);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  ELSE
    SELECT g.capability,ARRAY[g.id] INTO v_capability,v_sources
      FROM entitlement_grants g
      WHERE g.id=p_terminal_grant AND g.account_id=p_account
        AND g.source_kind='administrative' AND g.capability<>'business_os'
        AND g.status IN ('refunded','revoked')
        AND NOT EXISTS(SELECT 1 FROM administrative_grant_restorations r
          WHERE r.terminal_grant_id=g.id);
    IF NOT FOUND THEN
      v_outcome:='denied'; v_reason:='ADMINISTRATIVE_TERMINAL_GRANT_REQUIRED';
      v_sources:='{}';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    INSERT INTO entitlement_sources(id,account_id,source_kind,source_id,
      offer_code,academy_source_registry_id,provenance,created_at)
    VALUES(v_source,p_account,'administrative','staff:'||p_command::text,
      null,null,'staff-administrative-restoration',p_now);
    INSERT INTO entitlement_grants(id,account_id,source_registry_id,source_kind,
      source_id,offer_code,capability,status,starts_at,ends_at,provenance,
      created_at,updated_at)
    VALUES(v_grant,p_account,v_source,'administrative','staff:'||p_command::text,
      null,v_capability,'active',p_starts,p_ends,
      'staff-administrative-restoration',p_now,p_now);
    INSERT INTO administrative_grant_restorations(new_source_registry_id,
      account_id,terminal_grant_id,created_at)
    VALUES(v_source,p_account,p_terminal_grant,p_now);
    SELECT array_agg(source_id ORDER BY source_id) INTO v_sources
      FROM unnest(ARRAY[p_terminal_grant,v_grant]) AS source_ids(source_id);
    v_outcome:='applied'; v_reason:='ADMINISTRATIVE_RESTORATION_ALLOWED';
    v_result:=jsonb_build_object('sourceRegistryId',v_source,'grantId',v_grant,
      'capability',v_capability,'reasonCode',v_reason);
  ELSE
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'restore_administrative',v_outcome,v_result,'administrative:restore',v_reason,
    v_sources,p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_restore_administrative(uuid,uuid,text,uuid,timestamptz,timestamptz,text,timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_restore_administrative(uuid,uuid,text,uuid,timestamptz,timestamptz,text,timestamptz)
  TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_record_business_os_setup_purchase(
  p_account uuid,p_command uuid,p_input_hash text,p_source_id text,
  p_purchased_at timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_source uuid:=gen_random_uuid(); v_existing entitlement_sources%ROWTYPE;
DECLARE v_receipt_status text; v_reconciliation boolean;
DECLARE v_reconciliation_id uuid; v_nonterminal_source uuid;
DECLARE v_reconciliation_status text; v_reconciliation_created boolean;
BEGIN
  IF p_source_id IS NULL OR octet_length(p_source_id) NOT BETWEEN 1 AND 255
    OR p_purchased_at IS NULL OR NOT isfinite(p_purchased_at)
    OR p_purchased_at<>date_trunc('milliseconds',p_purchased_at)
    OR p_purchased_at<'2000-01-01 00:00:00+00'::timestamptz
    OR p_purchased_at>='10000-01-01 00:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'SYNTHOLO_BUSINESS_OS_SETUP_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase:'||p_source_id,0));
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'business_os_setup_paid',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active')
      AND v_command.result->>'receiptStatus'<>'paid_reconciliation' THEN
      RAISE EXCEPTION 'SYNTHOLO_ACCOUNT_INACTIVE' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO v_existing FROM entitlement_sources
    WHERE source_kind='purchase' AND source_id=p_source_id;
  IF FOUND THEN
    IF v_existing.account_id=p_account AND v_existing.offer_code='business_os'
      AND EXISTS(SELECT 1 FROM business_os_setup_receipts r
        WHERE r.source_registry_id=v_existing.id
          AND r.account_id=v_existing.account_id
          AND r.created_at=p_purchased_at) THEN
      v_outcome:='denied'; v_reason:='SOURCE_ALREADY_FULFILLED';
    ELSE
      v_reason:='SOURCE_RECONCILIATION_REQUIRED';
      SELECT reconciliation_id,reconciliation_status,created
        INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
        FROM syntholo_open_commerce_reconciliation(
        p_account,'business_os_setup_paid','purchase',p_source_id,p_input_hash,
        v_reason,'provider_source_collision',v_existing.id,null,p_now);
      v_outcome:='applied';
      v_result:=jsonb_build_object('sourceRegistryId',null,
        'reconciliationId',v_reconciliation_id,
        'reconciliationStatus',v_reconciliation_status,
        'reconciliationRequired',v_reconciliation_created,
        'receiptStatus','paid_reconciliation',
        'setupKind','provider_collision','reasonCode',v_reason);
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    SELECT source_registry_id INTO v_nonterminal_source
      FROM business_os_setup_receipts
      WHERE account_id=p_account AND status IN ('paid','paid_reconciliation')
      ORDER BY created_at,source_registry_id LIMIT 1;
    IF FOUND THEN
      v_reason:='BUSINESS_OS_SETUP_EPOCH_RECONCILIATION_REQUIRED';
      v_reconciliation:=true;
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    v_reconciliation:=coalesce(v_reconciliation,false)
      OR NOT EXISTS(SELECT 1 FROM accounts
        WHERE id=p_account AND status='active')
      OR EXISTS(SELECT 1 FROM account_holds WHERE account_id=p_account
        AND kind='commerce' AND released_at IS NULL);
    v_receipt_status:=CASE WHEN v_reconciliation THEN 'paid_reconciliation'
      ELSE 'paid' END;
    INSERT INTO entitlement_sources(id,account_id,source_kind,source_id,offer_code,
      academy_source_registry_id,provenance,created_at)
    VALUES(v_source,p_account,'purchase',p_source_id,'business_os',null,
      'commerce-business-os-setup',p_purchased_at);
    IF v_reconciliation THEN
      SELECT reconciliation_id,reconciliation_status,created
        INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
        FROM syntholo_open_commerce_reconciliation(
        p_account,'business_os_setup_paid','purchase',p_source_id,p_input_hash,
        coalesce(v_reason,'BUSINESS_OS_SETUP_RECONCILIATION_REQUIRED'),
        'parked_paid_receipt',
        v_source,null,p_now);
    END IF;
    INSERT INTO business_os_setup_receipts(source_registry_id,account_id,
      reconciliation_id,status,created_at,updated_at)
    VALUES(v_source,p_account,v_reconciliation_id,v_receipt_status,
      p_purchased_at,p_now);
    v_outcome:='applied'; v_reason:=CASE WHEN v_reconciliation
      THEN coalesce(v_reason,'BUSINESS_OS_SETUP_RECONCILIATION_REQUIRED')
      ELSE 'BUSINESS_OS_SETUP_RECORDED' END;
    v_result:=jsonb_build_object('sourceRegistryId',v_source,
      'reconciliationId',v_reconciliation_id,'receiptStatus',v_receipt_status,
      'reconciliationStatus',v_reconciliation_status,
      'reconciliationRequired',coalesce(v_reconciliation_created,false),
      'setupKind',CASE WHEN v_reconciliation THEN 'parked_receipt'
        ELSE 'recorded' END,'reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'business_os_setup_paid',v_outcome,v_result,'business_os:setup',v_reason,
    '{}'::uuid[],p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_record_business_os_setup_purchase(
  uuid,uuid,text,text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_record_business_os_setup_purchase(
  uuid,uuid,text,text,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_reconcile_business_os_setup(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_reconciliation_id uuid;
BEGIN
  IF p_source IS NULL OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_BUSINESS_OS_SETUP_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'reconcile_business_os_setup',p_input_hash,p_now,
    'syntholo_staff_api');
  IF v_command.replayed THEN
    IF syntholo_staff_administrative_boundary_reason(p_account,p_now) IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  v_reason:=syntholo_staff_administrative_boundary_reason(p_account,p_now);
  IF v_reason IS NOT NULL THEN
    v_outcome:='denied';
  ELSE
    SELECT reconciliation_id INTO v_reconciliation_id
      FROM business_os_setup_receipts
      WHERE source_registry_id=p_source AND account_id=p_account
        AND status='paid_reconciliation';
  END IF;
  IF v_outcome IS NULL AND NOT FOUND THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_SETUP_RECONCILIATION_UNAVAILABLE';
  ELSIF v_outcome IS NULL AND EXISTS(SELECT 1 FROM account_holds
      WHERE account_id=p_account AND released_at IS NULL
        AND kind IN ('commerce','business_os_activation')) THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_SETUP_HELD';
  ELSIF v_outcome IS NULL AND EXISTS(
      SELECT 1 FROM business_os_setup_receipts
      WHERE account_id=p_account AND status='paid'
        AND source_registry_id<>p_source) THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_SETUP_EPOCH_EXISTS';
  END IF;
  IF v_outcome IS NULL THEN
    PERFORM set_config('app.business_os_setup_transition',
      'syntholo-business-os-setup-v1',true);
    UPDATE business_os_setup_receipts SET status='paid',updated_at=p_now
      WHERE source_registry_id=p_source;
    PERFORM set_config('app.business_os_setup_transition','',true);
    PERFORM set_config('app.commerce_reconciliation_transition',
      'syntholo-commerce-reconciliation-v1',true);
    UPDATE commerce_reconciliations SET status='resolved_fulfilled',
      resolution_code='fulfilled',resolved_at=p_now,updated_at=p_now
      WHERE id=v_reconciliation_id AND account_id=p_account
        AND incident_kind='parked_paid_receipt'
        AND status IN ('open','claimed');
    PERFORM set_config('app.commerce_reconciliation_transition','',true);
    v_outcome:='applied'; v_reason:='BUSINESS_OS_SETUP_RECONCILED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'receiptStatus','paid','reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'reconcile_business_os_setup',v_outcome,v_result,
    'business_os:setup_reconciliation',v_reason,'{}'::uuid[],p_now,
    p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_reconcile_business_os_setup(
  uuid,uuid,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_reconcile_business_os_setup(
  uuid,uuid,text,uuid,text,timestamptz) TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_suspend_account(
  p_account uuid,p_command uuid,p_input_hash text,p_reason_input text,
  p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_boundary text;
BEGIN
  IF p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_ACCOUNT_LIFECYCLE_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'suspend_account',p_input_hash,p_now,'syntholo_staff_api');
  v_boundary:=syntholo_staff_entitlement_authority_reason(p_now);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  ELSIF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active') THEN
    v_outcome:='denied'; v_reason:='ACCOUNT_NOT_ACTIVE';
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE accounts SET status='suspended',updated_at=p_now WHERE id=p_account;
    v_outcome:='applied'; v_reason:='ACCOUNT_SUSPENDED';
    v_result:=jsonb_build_object('accountId',p_account,'status','suspended',
      'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'suspend_account',v_outcome,v_result,'account:suspend',v_reason,
    '{}'::uuid[],p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_suspend_account(uuid,uuid,text,text,timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_suspend_account(uuid,uuid,text,text,timestamptz)
  TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_reactivate_account(
  p_account uuid,p_command uuid,p_input_hash text,p_owner_membership uuid,
  p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_role text; v_status text; v_source uuid; v_slot integer;
BEGIN
  IF p_owner_membership IS NULL OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_ACCOUNT_LIFECYCLE_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'reactivate_account',p_input_hash,p_now,
    'syntholo_staff_api');
  IF v_command.replayed THEN
    IF syntholo_staff_entitlement_authority_reason(p_now) IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  v_reason:=syntholo_staff_entitlement_authority_reason(p_now);
  IF v_reason IS NOT NULL THEN
    v_outcome:='denied';
  ELSIF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account
      AND status='suspended') THEN
    v_outcome:='denied'; v_reason:='ACCOUNT_NOT_SUSPENDED';
  ELSE
    SELECT role,status INTO v_role,v_status FROM memberships
      WHERE id=p_owner_membership AND account_id=p_account;
    IF NOT FOUND OR v_status NOT IN ('active','revoked') THEN
      v_outcome:='denied'; v_reason:='OWNER_APPOINTMENT_REQUIRED';
    ELSIF EXISTS(SELECT 1 FROM memberships WHERE account_id=p_account
        AND role='owner' AND status='active' AND id<>p_owner_membership) THEN
      v_outcome:='denied'; v_reason:='OWNER_APPOINTMENT_CONFLICT';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    IF v_role<>'owner' OR v_status<>'active' THEN
      UPDATE memberships SET role='teammate',updated_at=p_now
        WHERE account_id=p_account AND role='owner' AND id<>p_owner_membership;
      UPDATE memberships SET role='owner',status='active',updated_at=p_now
        WHERE id=p_owner_membership;
      SELECT s.id INTO v_source FROM entitlement_sources s
        JOIN entitlement_grants course ON course.source_registry_id=s.id
          AND course.account_id=s.account_id
          AND course.capability='academy_course'
        WHERE s.account_id=p_account AND s.source_kind='purchase'
          AND s.offer_code IN ('self_paced','guided_pilot')
          AND course.source_kind='purchase'
          AND course.offer_code=s.offer_code
          AND course.status IN ('active','grace')
          AND course.starts_at<=p_now AND course.ends_at IS NULL
        ORDER BY s.created_at DESC,s.id LIMIT 1;
      IF v_source IS NOT NULL AND NOT EXISTS(SELECT 1 FROM seat_reservations
          WHERE account_id=p_account AND membership_id=p_owner_membership
            AND state='active') THEN
        SELECT slot INTO v_slot FROM generate_series(1,3) slot
          WHERE NOT EXISTS(SELECT 1 FROM seat_reservations r
            WHERE r.account_id=p_account AND r.slot=slot
              AND r.state IN ('active','pending'))
          ORDER BY slot LIMIT 1;
        IF v_slot IS NULL THEN
          RAISE EXCEPTION 'SYNTHOLO_OWNER_APPOINTMENT_SEAT_REQUIRED'
            USING ERRCODE='23514';
        END IF;
        INSERT INTO seat_reservations(account_id,slot,source_registry_id,state,
          membership_id,created_at,updated_at)
        VALUES(p_account,v_slot,v_source,'active',p_owner_membership,p_now,p_now);
      END IF;
    END IF;
    UPDATE accounts SET status='active',updated_at=p_now WHERE id=p_account;
    v_outcome:='applied'; v_reason:='ACCOUNT_REACTIVATED';
    v_result:=jsonb_build_object('accountId',p_account,'status','active',
      'ownerMembershipId',p_owner_membership,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'reactivate_account',v_outcome,v_result,'account:reactivate',v_reason,
    '{}'::uuid[],p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_reactivate_account(
  uuid,uuid,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_reactivate_account(
  uuid,uuid,text,uuid,text,timestamptz) TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_revoke_member(
  p_account uuid,p_command uuid,p_input_hash text,p_membership uuid,
  p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_reservation uuid; v_sources uuid[]:='{}'; v_boundary text;
BEGIN
  IF p_membership IS NULL OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_MEMBER_REVOCATION_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'revoke_member',p_input_hash,p_now,'syntholo_staff_api');
  v_boundary:=syntholo_staff_administrative_boundary_reason(p_account,p_now);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  ELSE
    SELECT r.id INTO v_reservation FROM memberships m
      JOIN seat_reservations r ON r.membership_id=m.id
        AND r.account_id=m.account_id AND r.state='active'
      WHERE m.id=p_membership AND m.account_id=p_account
        AND m.status='active' AND m.role='teammate';
    IF NOT FOUND THEN
      v_outcome:='denied'; v_reason:='ACTIVE_TEAMMATE_REQUIRED';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    SELECT array_agg(g.id ORDER BY g.id) INTO v_sources
      FROM seat_reservations r JOIN entitlement_grants g
        ON g.source_registry_id=r.source_registry_id
        AND g.account_id=r.account_id AND g.capability='academy_course'
      WHERE r.id=v_reservation;
    UPDATE memberships SET status='revoked',updated_at=p_now WHERE id=p_membership;
    UPDATE seat_reservations SET state='revoked',updated_at=p_now
      WHERE id=v_reservation;
    v_outcome:='applied'; v_reason:='MEMBER_REVOKED';
    v_result:=jsonb_build_object('membershipId',p_membership,
      'reservationId',v_reservation,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'revoke_member',v_outcome,v_result,'member:revoke',v_reason,
    coalesce(v_sources,'{}'),p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_revoke_member(
  uuid,uuid,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_revoke_member(
  uuid,uuid,text,uuid,text,timestamptz) TO syntholo_staff_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION syntholo_validate_token_deadline() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='INSERT' AND (NEW.consumed_at IS NOT NULL OR NEW.superseded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SYNTHOLO_TOKEN_HISTORY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM seat_invitations i WHERE i.id=NEW.invitation_id
    AND i.account_id=NEW.account_id AND i.expires_at=NEW.expires_at) THEN
    RAISE EXCEPTION 'SYNTHOLO_INVITATION_DEADLINE_INVALID' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.account_id,NEW.invitation_id,NEW.generation,NEW.token_hash,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.invitation_id,OLD.generation,OLD.token_hash,OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION 'SYNTHOLO_TOKEN_HISTORY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
    OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
    OR (OLD.consumed_at IS NULL AND OLD.superseded_at IS NULL
      AND ((NEW.consumed_at IS NULL)=(NEW.superseded_at IS NULL)))
    OR coalesce(NEW.consumed_at,NEW.superseded_at)>=NEW.expires_at) THEN
    RAISE EXCEPTION 'SYNTHOLO_TOKEN_HISTORY_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_validate_token_deadline() FROM PUBLIC;
CREATE TRIGGER seat_invitation_tokens_validate BEFORE INSERT OR UPDATE ON seat_invitation_token_generations
  FOR EACH ROW EXECUTE FUNCTION syntholo_validate_token_deadline();
--> statement-breakpoint
CREATE FUNCTION prevent_entitlement_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN RAISE EXCEPTION 'SYNTHOLO_ENTITLEMENT_HISTORY_APPEND_ONLY' USING ERRCODE='55000'; END;
$fn$;
REVOKE ALL ON FUNCTION prevent_entitlement_history_mutation() FROM PUBLIC;
CREATE TRIGGER seat_invitations_append_only_rows BEFORE UPDATE OR DELETE ON seat_invitations
  FOR EACH ROW EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER seat_invitations_append_only_truncate BEFORE TRUNCATE ON seat_invitations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER entitlement_sources_append_only_delete BEFORE DELETE OR TRUNCATE ON entitlement_sources
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER business_os_setup_receipts_append_only_delete
  BEFORE DELETE OR TRUNCATE ON business_os_setup_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER commerce_fulfillment_receipts_append_only_delete
  BEFORE DELETE OR TRUNCATE ON commerce_fulfillment_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER commerce_reconciliations_append_only_delete
  BEFORE DELETE OR TRUNCATE ON commerce_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER entitlement_grants_append_only_delete BEFORE DELETE OR TRUNCATE ON entitlement_grants
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER account_hold_sources_append_only_delete BEFORE DELETE OR TRUNCATE ON account_hold_sources
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER account_holds_append_only_delete BEFORE DELETE OR TRUNCATE ON account_holds
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER seat_invitation_tokens_append_only_delete BEFORE DELETE OR TRUNCATE ON seat_invitation_token_generations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER seat_reservations_append_only_delete BEFORE DELETE OR TRUNCATE ON seat_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER access_decision_audit_append_only_rows BEFORE UPDATE OR DELETE ON access_decision_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER access_decision_audit_append_only_truncate BEFORE TRUNCATE ON access_decision_audit
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
ALTER TABLE seat_invitations ENABLE ALWAYS TRIGGER seat_invitations_append_only_rows;
ALTER TABLE seat_invitations ENABLE ALWAYS TRIGGER seat_invitations_append_only_truncate;
ALTER TABLE entitlement_sources ENABLE ALWAYS TRIGGER entitlement_sources_append_only_delete;
ALTER TABLE business_os_setup_receipts ENABLE ALWAYS TRIGGER
  business_os_setup_receipts_append_only_delete;
ALTER TABLE business_os_setup_receipts ENABLE ALWAYS TRIGGER
  business_os_setup_receipts_transition_guard;
ALTER TABLE commerce_fulfillment_receipts ENABLE ALWAYS TRIGGER
  commerce_fulfillment_receipts_append_only_delete;
ALTER TABLE commerce_fulfillment_receipts ENABLE ALWAYS TRIGGER
  commerce_fulfillment_receipts_transition_guard;
ALTER TABLE commerce_reconciliations ENABLE ALWAYS TRIGGER
  commerce_reconciliations_append_only_delete;
ALTER TABLE commerce_reconciliations ENABLE ALWAYS TRIGGER
  commerce_reconciliations_transition_guard;
ALTER TABLE entitlement_grants ENABLE ALWAYS TRIGGER entitlement_grants_append_only_delete;
ALTER TABLE account_hold_sources ENABLE ALWAYS TRIGGER account_hold_sources_append_only_delete;
ALTER TABLE account_holds ENABLE ALWAYS TRIGGER account_holds_append_only_delete;
ALTER TABLE seat_invitation_token_generations ENABLE ALWAYS TRIGGER seat_invitation_tokens_append_only_delete;
ALTER TABLE seat_reservations ENABLE ALWAYS TRIGGER seat_reservations_append_only_delete;
CREATE TRIGGER club_subscription_cancellations_append_only_rows
  BEFORE UPDATE OR DELETE ON club_subscription_cancellations
  FOR EACH ROW EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER club_subscription_cancellations_append_only_truncate
  BEFORE TRUNCATE ON club_subscription_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
ALTER TABLE club_subscription_cancellations ENABLE ALWAYS TRIGGER
  club_subscription_cancellations_append_only_rows;
ALTER TABLE club_subscription_cancellations ENABLE ALWAYS TRIGGER
  club_subscription_cancellations_append_only_truncate;
CREATE TRIGGER business_os_subscription_cancellations_append_only_rows
  BEFORE UPDATE OR DELETE ON business_os_subscription_cancellations
  FOR EACH ROW EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER business_os_subscription_cancellations_append_only_truncate
  BEFORE TRUNCATE ON business_os_subscription_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
ALTER TABLE business_os_subscription_cancellations ENABLE ALWAYS TRIGGER
  business_os_subscription_cancellations_append_only_rows;
ALTER TABLE business_os_subscription_cancellations ENABLE ALWAYS TRIGGER
  business_os_subscription_cancellations_append_only_truncate;
ALTER TABLE access_decision_audit ENABLE ALWAYS TRIGGER access_decision_audit_append_only_rows;
ALTER TABLE access_decision_audit ENABLE ALWAYS TRIGGER access_decision_audit_append_only_truncate;
CREATE TRIGGER administrative_grant_restorations_append_only_rows
  BEFORE UPDATE OR DELETE ON administrative_grant_restorations
  FOR EACH ROW EXECUTE FUNCTION prevent_entitlement_history_mutation();
CREATE TRIGGER administrative_grant_restorations_append_only_truncate
  BEFORE TRUNCATE ON administrative_grant_restorations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_entitlement_history_mutation();
ALTER TABLE administrative_grant_restorations ENABLE ALWAYS TRIGGER
  administrative_grant_restorations_append_only_rows;
ALTER TABLE administrative_grant_restorations ENABLE ALWAYS TRIGGER
  administrative_grant_restorations_append_only_truncate;
--> statement-breakpoint
CREATE FUNCTION syntholo_guard_entitlement_command_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP<>'UPDATE'
    OR current_setting('app.entitlement_command_completion',true)
      IS DISTINCT FROM 'syntholo-command-v1'
    OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL
    OR (NEW.command_id,NEW.account_id,NEW.command_kind,NEW.actor_type,NEW.actor_id,
        NEW.first_correlation_id,NEW.input_hash,NEW.occurred_at)
       IS DISTINCT FROM
       (OLD.command_id,OLD.account_id,OLD.command_kind,OLD.actor_type,OLD.actor_id,
        OLD.first_correlation_id,OLD.input_hash,OLD.occurred_at)
  THEN
    RAISE EXCEPTION 'SYNTHOLO_COMMAND_HISTORY_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_guard_entitlement_command_history() FROM PUBLIC;
CREATE TRIGGER entitlement_commands_append_only_rows
  BEFORE UPDATE OR DELETE ON entitlement_commands
  FOR EACH ROW EXECUTE FUNCTION syntholo_guard_entitlement_command_history();
CREATE TRIGGER entitlement_commands_append_only_truncate
  BEFORE TRUNCATE ON entitlement_commands
  FOR EACH STATEMENT EXECUTE FUNCTION syntholo_guard_entitlement_command_history();
ALTER TABLE entitlement_commands ENABLE ALWAYS TRIGGER entitlement_commands_append_only_rows;
ALTER TABLE entitlement_commands ENABLE ALWAYS TRIGGER entitlement_commands_append_only_truncate;
--> statement-breakpoint
CREATE FUNCTION syntholo_member_owner_boundary_reason(p_account uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_membership uuid; v_actor uuid;
BEGIN
  BEGIN
    v_membership:=nullif(current_setting('app.membership_id',true),'')::uuid;
    v_actor:=nullif(current_setting('app.actor_id',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN 'MEMBER_INACTIVE';
  END;
  IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active') THEN
    RETURN 'ACCOUNT_INACTIVE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM memberships WHERE id=v_membership
      AND account_id=p_account AND member_identity_id=v_actor AND status='active') THEN
    RETURN 'MEMBER_INACTIVE';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM memberships WHERE id=v_membership
      AND account_id=p_account AND role='owner' AND status='active') THEN
    RETURN 'OWNER_REQUIRED';
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_member_owner_boundary_reason(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION syntholo_reserve_pending_seat(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,p_email text,
  p_token_hash bytea,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_slot integer; v_invitation uuid:=gen_random_uuid();
DECLARE v_reservation uuid:=gen_random_uuid(); v_command record;
DECLARE v_outcome text; v_reason text; v_result jsonb; v_sources uuid[]:='{}';
DECLARE v_boundary text;
BEGIN
  IF p_source IS NULL OR p_email IS NULL OR p_token_hash IS NULL
    OR octet_length(p_token_hash)<>32 OR lower(btrim(p_email))!~'^[^[:space:]@]+@[^[:space:]@]+$'
    OR octet_length(lower(btrim(p_email))) NOT BETWEEN 3 AND 320 THEN
    RAISE EXCEPTION 'SYNTHOLO_SEAT_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'reserve_seat',p_input_hash,p_now,'syntholo_member_api');
  v_boundary:=syntholo_member_owner_boundary_reason(p_account);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_OWNER_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM account_holds
    WHERE v_outcome IS NULL AND account_id=p_account
      AND kind='seat_changes' AND released_at IS NULL;
  IF v_outcome IS NULL AND coalesce(cardinality(v_sources),0)>0 THEN
    v_outcome:='denied'; v_reason:='SEAT_CHANGES_HELD';
  END IF;
  IF v_outcome IS NULL THEN
    SELECT s INTO v_slot FROM generate_series(1,3) s
     WHERE NOT EXISTS(SELECT 1 FROM seat_reservations r WHERE r.account_id=p_account
       AND r.slot=s AND (r.state='active'
         OR (r.state='pending' AND r.expires_at>p_now))) ORDER BY s LIMIT 1;
    IF v_slot IS NULL THEN
      v_outcome:='denied'; v_reason:='SEAT_CAPACITY_REACHED';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE source_registry_id=p_source AND account_id=p_account
        AND capability='academy_course' AND source_kind='purchase'
        AND offer_code IN ('self_paced','guided_pilot')
        AND status IN ('active','grace') AND ends_at IS NULL;
    IF coalesce(cardinality(v_sources),0)<>1 THEN
      v_outcome:='denied'; v_reason:='ACADEMY_SOURCE_REQUIRED';
      v_sources:='{}';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE seat_reservations r SET state='expired',updated_at=p_now
      WHERE r.account_id=p_account AND r.state='pending'
        AND r.expires_at<=p_now;
    INSERT INTO seat_invitations(id,account_id,normalized_email,expires_at,created_at)
      VALUES(v_invitation,p_account,lower(btrim(p_email)),p_now+interval '168 hours',p_now);
    INSERT INTO seat_invitation_token_generations(account_id,invitation_id,generation,token_hash,expires_at,created_at)
      VALUES(p_account,v_invitation,1,p_token_hash,p_now+interval '168 hours',p_now);
    INSERT INTO seat_reservations(id,account_id,slot,source_registry_id,state,invitation_id,expires_at,created_at,updated_at)
      VALUES(v_reservation,p_account,v_slot,p_source,'pending',v_invitation,p_now+interval '168 hours',p_now,p_now);
    v_outcome:='applied'; v_reason:='SEAT_INVITE_ALLOWED';
    v_result:=jsonb_build_object('reservationId',v_reservation,
      'invitationId',v_invitation,'slot',v_slot,
      'expiresAt',p_now+interval '168 hours','reasonCode',v_reason);
  ELSE
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,'reserve_seat',
    v_outcome,v_result,'hold:seat_changes',v_reason,coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_reserve_pending_seat(uuid,uuid,text,uuid,text,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_reserve_pending_seat(uuid,uuid,text,uuid,text,bytea,timestamptz)
  TO syntholo_member_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION syntholo_resend_invitation(p_account uuid,p_command uuid,
  p_input_hash text,p_invitation uuid,p_token_hash bytea,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_exp timestamptz; v_gen integer; v_command record;
DECLARE v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_boundary text;
BEGIN
  IF p_invitation IS NULL OR p_token_hash IS NULL
    OR octet_length(p_token_hash)<>32 THEN
    RAISE EXCEPTION 'SYNTHOLO_SEAT_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'resend_invitation',p_input_hash,p_now,
    'syntholo_member_api');
  v_boundary:=syntholo_member_owner_boundary_reason(p_account);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_OWNER_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM account_holds
    WHERE v_outcome IS NULL AND account_id=p_account
      AND kind='seat_changes' AND released_at IS NULL;
  IF v_outcome IS NULL AND coalesce(cardinality(v_sources),0)>0 THEN
    v_outcome:='denied'; v_reason:='SEAT_CHANGES_HELD';
  END IF;
  SELECT i.expires_at INTO v_exp FROM seat_invitations i
    JOIN seat_reservations r ON r.invitation_id=i.id AND r.account_id=i.account_id
    WHERE v_outcome IS NULL AND i.id=p_invitation AND i.account_id=p_account
      AND r.state='pending';
  IF v_outcome IS NULL AND (NOT FOUND OR v_exp<=p_now) THEN
    v_outcome:='denied'; v_reason:='INVITATION_INACTIVE';
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE seat_invitation_token_generations AS token SET superseded_at=p_now
      WHERE token.invitation_id=p_invitation
        AND token.consumed_at IS NULL AND token.superseded_at IS NULL;
    SELECT coalesce(max(token.generation),0)+1 INTO v_gen
      FROM seat_invitation_token_generations AS token
      WHERE token.invitation_id=p_invitation;
    INSERT INTO seat_invitation_token_generations(account_id,invitation_id,
      generation,token_hash,expires_at,created_at)
      VALUES(p_account,p_invitation,v_gen,p_token_hash,v_exp,p_now);
    v_outcome:='applied'; v_reason:='INVITATION_RESEND_ALLOWED';
    v_result:=jsonb_build_object('invitationId',p_invitation,
      'expiresAt',v_exp,'generation',v_gen,'reasonCode',v_reason);
  ELSE
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'resend_invitation',v_outcome,v_result,'hold:seat_changes',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_resend_invitation(uuid,uuid,text,uuid,bytea,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_resend_invitation(uuid,uuid,text,uuid,bytea,timestamptz)
  TO syntholo_member_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION syntholo_establish_owner(p_account uuid,p_command uuid,
  p_input_hash text,p_clerk_user text,p_email text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_identity uuid:=gen_random_uuid(); v_membership uuid:=gen_random_uuid();
DECLARE v_source uuid; v_grant uuid; v_command record; v_outcome text;
DECLARE v_reason text; v_result jsonb; v_sources uuid[]:='{}';
DECLARE v_constraint text;
BEGIN
  PERFORM syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_clerk_user IS NULL OR p_email IS NULL
    OR octet_length(p_clerk_user) NOT BETWEEN 1 AND 255
    OR lower(btrim(p_email))!~'^[^[:space:]@]+@[^[:space:]@]+$'
    OR octet_length(lower(btrim(p_email))) NOT BETWEEN 3 AND 320 THEN
    RAISE EXCEPTION 'SYNTHOLO_OWNER_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'establish_owner',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active') THEN
      RAISE EXCEPTION 'SYNTHOLO_ACCOUNT_INACTIVE' USING ERRCODE='42501';
    END IF;
    IF v_command.outcome='applied' AND NOT EXISTS(
      SELECT 1 FROM memberships m
      JOIN member_identities i ON i.id=m.member_identity_id
        AND i.account_id=m.account_id
      WHERE m.id=(v_command.result->>'membershipId')::uuid
        AND m.account_id=p_account AND m.status='active'
        AND i.provider='clerk' AND i.provider_user_id=p_clerk_user) THEN
      RAISE EXCEPTION 'SYNTHOLO_MEMBERSHIP_INACTIVE' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active') THEN
    v_outcome:='denied'; v_reason:='ACCOUNT_INACTIVE';
  ELSIF EXISTS(SELECT 1 FROM memberships WHERE account_id=p_account AND role='owner' AND status='active') THEN
    v_outcome:='denied'; v_reason:='OWNER_EXISTS';
  END IF;
  SELECT source_registry_id,id INTO v_source,v_grant FROM entitlement_grants
    WHERE v_outcome IS NULL AND account_id=p_account
    AND capability='academy_course' AND source_kind='purchase'
    AND offer_code IN ('self_paced','guided_pilot') AND status IN ('active','grace')
    AND ends_at IS NULL ORDER BY id LIMIT 1;
  IF v_grant IS NOT NULL THEN v_sources:=ARRAY[v_grant]; END IF;
  IF v_outcome IS NULL THEN
    BEGIN
      INSERT INTO member_identities(id,account_id,provider,provider_user_id,email)
        VALUES(v_identity,p_account,'clerk',p_clerk_user,lower(btrim(p_email)));
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
      IF v_constraint<>'member_identities_provider_user_unique' THEN RAISE; END IF;
      v_outcome:='denied'; v_reason:='IDENTITY_ALREADY_CLAIMED';
    END;
    IF v_outcome IS NULL THEN
      INSERT INTO memberships(id,account_id,member_identity_id,role,status)
        VALUES(v_membership,p_account,v_identity,'owner','active');
      PERFORM set_config('app.owner_claim_transition','syntholo-owner-claim-v1',true);
      UPDATE accounts SET owner_established_at=coalesce(owner_established_at,p_now),
        updated_at=p_now WHERE id=p_account;
      PERFORM set_config('app.owner_claim_transition','',true);
    END IF;
  END IF;
  IF v_outcome IS NULL AND v_source IS NOT NULL THEN
    INSERT INTO seat_reservations(account_id,slot,source_registry_id,state,membership_id,created_at,updated_at)
      VALUES(p_account,1,v_source,'active',v_membership,p_now,p_now);
  END IF;
  IF v_outcome IS NULL THEN
    v_outcome:='applied'; v_reason:='OWNER_CLAIM_ALLOWED';
    v_result:=jsonb_build_object('identityId',v_identity,'membershipId',v_membership,
      'seatActivated',v_source IS NOT NULL,'reasonCode',v_reason);
  ELSE
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'establish_owner',v_outcome,v_result,'role:owner',v_reason,v_sources,p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_establish_owner(uuid,uuid,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_establish_owner(uuid,uuid,text,text,text,timestamptz)
  TO syntholo_system_api;
--> statement-breakpoint
CREATE FUNCTION syntholo_one_year_anniversary_utc(p_start timestamptz)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
  SELECT make_timestamptz(
    extract(year from (p_start at time zone 'UTC'))::int+1,
    extract(month from (p_start at time zone 'UTC'))::int,
    least(
      extract(day from (p_start at time zone 'UTC'))::int,
      extract(day from (date_trunc('month',(p_start at time zone 'UTC'))
        + interval '1 year 1 month -1 day'))::int),
    extract(hour from (p_start at time zone 'UTC'))::int,
    extract(minute from (p_start at time zone 'UTC'))::int,
    extract(second from (p_start at time zone 'UTC')),
    'UTC')
$fn$;
REVOKE ALL ON FUNCTION syntholo_one_year_anniversary_utc(timestamptz) FROM PUBLIC;

CREATE FUNCTION syntholo_fulfill_product(
  p_account uuid,p_command uuid,p_input_hash text,p_source_kind text,
  p_source_id text,p_offer text,p_academy_source uuid,p_starts timestamptz,
  p_ends timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_source uuid:=gen_random_uuid(); v_command record;
DECLARE v_outcome text; v_reason text; v_result jsonb;
DECLARE v_support_end timestamptz; v_sources uuid[]:='{}';
DECLARE v_owner_membership uuid;
DECLARE v_existing_source uuid; v_existing_account uuid;
DECLARE v_existing_offer text; v_existing_parent uuid; v_existing_shape boolean;
DECLARE v_reconciliation boolean:=false; v_account_active boolean;
DECLARE v_existing_receipt commerce_fulfillment_receipts%ROWTYPE;
DECLARE v_reconciliation_id uuid;
DECLARE v_reconciliation_status text; v_reconciliation_created boolean;
BEGIN
  IF p_source_kind IS NULL OR p_offer IS NULL
    OR p_source_id IS NULL OR octet_length(p_source_id) NOT BETWEEN 1 AND 255
    OR p_starts IS NULL OR p_starts<>date_trunc('milliseconds',p_starts)
    OR (p_ends IS NOT NULL AND (p_ends<>date_trunc('milliseconds',p_ends)
      OR p_ends<=p_starts))
    OR NOT (
      (p_source_kind='purchase' AND p_offer IN ('self_paced','guided_pilot')
        AND p_academy_source IS NULL AND p_ends IS NULL)
      OR (p_source_kind='subscription'
        AND p_offer IN ('operator_club_monthly','operator_club_annual')
        AND p_academy_source IS NOT NULL AND p_ends IS NOT NULL)
      OR (p_source_kind='subscription' AND p_offer='business_os'
        AND p_academy_source IS NULL AND p_ends IS NOT NULL)) THEN
    RAISE EXCEPTION 'SYNTHOLO_PRODUCT_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_source_kind||':'||p_source_id,0));
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'fulfill_product',p_input_hash,p_now,'syntholo_system_api');
  IF v_command.replayed THEN
    IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active')
      AND v_command.result->>'fulfillmentStatus'<>'reconciliation' THEN
      RAISE EXCEPTION 'SYNTHOLO_ACCOUNT_INACTIVE' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;

  SELECT status='active' INTO v_account_active FROM accounts WHERE id=p_account;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM account_holds
    WHERE account_id=p_account AND kind='commerce' AND released_at IS NULL;
  v_reconciliation:=NOT coalesce(v_account_active,false)
    OR coalesce(cardinality(v_sources),0)>0;

  IF v_outcome IS NULL THEN
    SELECT id,account_id,offer_code,academy_source_registry_id
      INTO v_existing_source,v_existing_account,v_existing_offer,v_existing_parent
      FROM entitlement_sources
      WHERE source_kind=p_source_kind AND source_id=p_source_id;
    IF FOUND THEN
      SELECT coalesce(array_agg(g.id ORDER BY g.id),'{}'::uuid[]) INTO v_sources
        FROM entitlement_grants g WHERE g.source_registry_id=v_existing_source;
      SELECT * INTO v_existing_receipt FROM commerce_fulfillment_receipts
        WHERE source_registry_id=v_existing_source;
      v_existing_shape:=v_existing_account=p_account
        AND v_existing_offer=p_offer
        AND v_existing_parent IS NOT DISTINCT FROM p_academy_source
        AND (v_existing_receipt.source_registry_id IS NULL OR (
          v_existing_receipt.starts_at=p_starts
          AND v_existing_receipt.ends_at IS NOT DISTINCT FROM p_ends))
        AND ((p_offer IN ('self_paced','guided_pilot')
            AND (cardinality(v_sources)=3
              OR (cardinality(v_sources)=0
                AND v_existing_receipt.status='reconciliation'))
            AND NOT EXISTS(SELECT 1 FROM entitlement_grants g
              WHERE g.source_registry_id=v_existing_source
                AND g.capability NOT IN ('academy_course','support','circle_write')))
          OR (p_offer IN ('operator_club_monthly','operator_club_annual')
            AND (cardinality(v_sources)=3
              OR (cardinality(v_sources)=0
                AND v_existing_receipt.status='reconciliation'))
            AND NOT EXISTS(SELECT 1 FROM entitlement_grants g
              WHERE g.source_registry_id=v_existing_source
                AND g.capability NOT IN ('support','circle_write','operator_club')))
          OR (p_offer='business_os' AND p_source_kind='subscription'
            AND ((cardinality(v_sources)=1
                AND EXISTS(SELECT 1 FROM entitlement_grants g
                  WHERE g.source_registry_id=v_existing_source
                    AND g.capability='business_os'))
              OR (cardinality(v_sources)=0
                AND v_existing_receipt.status='reconciliation'))));
    END IF;
  END IF;
  IF v_outcome IS NULL AND v_existing_source IS NOT NULL THEN
    IF NOT coalesce(v_existing_shape,false) THEN
      v_reason:='SOURCE_RECONCILIATION_REQUIRED';
      SELECT reconciliation_id,reconciliation_status,created
        INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
        FROM syntholo_open_commerce_reconciliation(
        p_account,'fulfill_product',p_source_kind,p_source_id,p_input_hash,
        v_reason,'provider_source_collision',v_existing_source,null,p_now);
      v_sources:='{}';
      v_outcome:='applied';
      v_result:=jsonb_build_object('reconciliationId',v_reconciliation_id,
        'reconciliationStatus',v_reconciliation_status,
        'reconciliationRequired',v_reconciliation_created,
        'sourceRegistryId',null,'supportEndsAt',null,
        'fulfillmentStatus','reconciliation',
        'reconciliationKind','provider_collision','reasonCode',v_reason);
    ELSE
      v_outcome:='denied'; v_reason:='SOURCE_ALREADY_FULFILLED';
    END IF;
  ELSIF v_outcome IS NULL AND NOT v_reconciliation
    AND p_offer IN ('self_paced','guided_pilot') THEN
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE account_id=p_account AND capability='academy_course'
        AND source_kind='purchase' AND offer_code IN ('self_paced','guided_pilot')
        AND status IN ('active','grace');
    IF coalesce(cardinality(v_sources),0)>0 THEN
      v_reconciliation:=true;
      v_reason:='ACADEMY_PURCHASE_RECONCILIATION_REQUIRED';
    ELSE
      v_support_end:=syntholo_one_year_anniversary_utc(p_starts);
    END IF;
  ELSIF v_outcome IS NULL AND NOT v_reconciliation
    AND p_offer IN ('operator_club_monthly','operator_club_annual') THEN
    SELECT array_agg(DISTINCT g.id ORDER BY g.id) INTO v_sources
      FROM entitlement_sources s JOIN entitlement_grants g
        ON g.source_registry_id=s.id AND g.account_id=s.account_id
      WHERE s.account_id=p_account AND s.source_kind='subscription'
        AND s.offer_code IN ('operator_club_monthly','operator_club_annual')
        AND g.status IN ('active','grace');
    IF coalesce(cardinality(v_sources),0)>0 THEN
      v_reconciliation:=true;
      v_reason:='CLUB_SUBSCRIPTION_RECONCILIATION_REQUIRED';
    ELSIF NOT EXISTS(
      SELECT 1 FROM entitlement_sources a
      JOIN entitlement_grants course ON course.source_registry_id=a.id
        AND course.account_id=a.account_id AND course.capability='academy_course'
        AND course.source_kind='purchase'
        AND course.offer_code IN ('self_paced','guided_pilot')
        AND course.status IN ('active','grace')
        AND course.starts_at<=p_now AND course.ends_at IS NULL
      JOIN entitlement_grants support ON support.source_registry_id=a.id
        AND support.account_id=a.account_id AND support.capability='support'
      WHERE a.id=p_academy_source AND a.account_id=p_account
        AND greatest(support.ends_at,p_now)=p_starts) THEN
      v_reconciliation:=true; v_reason:='CLUB_ACADEMY_PAIR_REQUIRED';
      v_sources:='{}';
    END IF;
  ELSIF v_outcome IS NULL AND NOT v_reconciliation
    AND p_offer='business_os' THEN
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE account_id=p_account AND capability='business_os'
        AND source_kind='subscription' AND offer_code='business_os'
        AND status IN ('active','grace');
    IF coalesce(cardinality(v_sources),0)>0 THEN
      v_reconciliation:=true;
      v_reason:='BUSINESS_OS_SUBSCRIPTION_RECONCILIATION_REQUIRED';
    END IF;
  END IF;

  IF v_outcome IS NULL THEN
    INSERT INTO entitlement_sources(id,account_id,source_kind,source_id,offer_code,
      academy_source_registry_id,provenance,created_at)
    VALUES(v_source,p_account,p_source_kind,p_source_id,p_offer,
      p_academy_source,'commerce',p_now);
    IF v_reconciliation THEN
      v_sources:=coalesce(v_sources,'{}');
      SELECT reconciliation_id,reconciliation_status,created
        INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
        FROM syntholo_open_commerce_reconciliation(
        p_account,'fulfill_product',p_source_kind,p_source_id,p_input_hash,
        coalesce(v_reason,'PRODUCT_FULFILLMENT_RECONCILIATION_REQUIRED'),
        'parked_paid_receipt',
        v_source,null,p_now);
    ELSIF p_offer IN ('self_paced','guided_pilot') THEN
      INSERT INTO entitlement_grants(account_id,source_registry_id,source_kind,
        source_id,offer_code,capability,status,starts_at,ends_at,provenance,
        created_at,updated_at)
      VALUES
        (p_account,v_source,p_source_kind,p_source_id,p_offer,'academy_course',
          'active',p_starts,null,'commerce',p_now,p_now),
        (p_account,v_source,p_source_kind,p_source_id,p_offer,'support',
          'active',p_starts,v_support_end,'commerce',p_now,p_now),
        (p_account,v_source,p_source_kind,p_source_id,p_offer,'circle_write',
          'active',p_starts,v_support_end,'commerce',p_now,p_now);
      SELECT id INTO v_owner_membership FROM memberships
        WHERE account_id=p_account AND role='owner' AND status='active';
      IF v_owner_membership IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM seat_reservations WHERE account_id=p_account
            AND membership_id=v_owner_membership AND state='active') THEN
        INSERT INTO seat_reservations(account_id,slot,source_registry_id,state,
          membership_id,created_at,updated_at)
        VALUES(p_account,1,v_source,'active',v_owner_membership,p_now,p_now);
      END IF;
    ELSIF p_offer IN ('operator_club_monthly','operator_club_annual') THEN
      INSERT INTO entitlement_grants(account_id,source_registry_id,source_kind,
        source_id,offer_code,capability,status,starts_at,ends_at,provenance,
        created_at,updated_at)
      SELECT p_account,v_source,p_source_kind,p_source_id,p_offer,capability,
        CASE WHEN p_ends<=p_now THEN 'expired' ELSE 'active' END,
        p_starts,p_ends,'commerce',p_now,p_now
      FROM unnest(ARRAY['support','circle_write','operator_club']) capability;
    ELSE
      INSERT INTO entitlement_grants(account_id,source_registry_id,source_kind,
        source_id,offer_code,capability,status,starts_at,ends_at,provenance,
        created_at,updated_at)
      VALUES(p_account,v_source,p_source_kind,p_source_id,p_offer,'business_os',
        CASE WHEN p_ends<=p_now THEN 'expired' ELSE 'active' END,
        p_starts,p_ends,'commerce',p_now,p_now);
    END IF;
    INSERT INTO commerce_fulfillment_receipts(source_registry_id,account_id,
      reconciliation_id,status,starts_at,ends_at,created_at,updated_at)
    VALUES(v_source,p_account,v_reconciliation_id,
      CASE WHEN v_reconciliation THEN 'reconciliation' ELSE 'fulfilled' END,
      p_starts,p_ends,p_now,p_now);
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE source_registry_id=v_source;
    v_outcome:='applied'; v_reason:=CASE WHEN v_reconciliation
      THEN coalesce(v_reason,'PRODUCT_FULFILLMENT_RECONCILIATION_REQUIRED')
      ELSE 'PRODUCT_FULFILLMENT_ALLOWED' END;
    v_result:=jsonb_build_object('sourceRegistryId',v_source,
      'supportEndsAt',v_support_end,
      'fulfillmentStatus',CASE WHEN v_reconciliation THEN 'reconciliation'
        ELSE 'fulfilled' END,'reconciliationId',v_reconciliation_id,
      'reconciliationStatus',v_reconciliation_status,
      'reconciliationRequired',coalesce(v_reconciliation_created,false),
      'reconciliationKind',CASE WHEN v_reconciliation
        THEN 'parked_receipt' ELSE null END,
      'reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'fulfill_product',v_outcome,v_result,'product:fulfillment',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_fulfill_product(uuid,uuid,text,text,text,text,uuid,timestamptz,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_fulfill_product(uuid,uuid,text,text,text,text,uuid,timestamptz,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_reconcile_product_fulfillment(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_product entitlement_sources%ROWTYPE;
DECLARE v_receipt commerce_fulfillment_receipts%ROWTYPE;
DECLARE v_support_end timestamptz; v_owner_membership uuid;
DECLARE v_sources uuid[]:='{}';
BEGIN
  IF p_source IS NULL OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_PRODUCT_RECONCILIATION_INPUT_INVALID'
      USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'reconcile_product_fulfillment',p_input_hash,p_now,
    'syntholo_staff_api');
  IF v_command.replayed THEN
    IF syntholo_staff_administrative_boundary_reason(p_account,p_now) IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_STAFF_AUTHORITY_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  v_reason:=syntholo_staff_administrative_boundary_reason(p_account,p_now);
  IF v_reason IS NOT NULL THEN
    v_outcome:='denied';
  ELSE
    SELECT * INTO v_product FROM entitlement_sources
      WHERE id=p_source AND account_id=p_account;
    SELECT * INTO v_receipt FROM commerce_fulfillment_receipts
      WHERE source_registry_id=p_source AND account_id=p_account
        AND status='reconciliation';
    IF v_product.id IS NULL OR v_receipt.source_registry_id IS NULL THEN
      v_outcome:='denied'; v_reason:='PRODUCT_RECONCILIATION_UNAVAILABLE';
    ELSIF EXISTS(SELECT 1 FROM account_holds WHERE account_id=p_account
        AND kind='commerce' AND released_at IS NULL) THEN
      v_outcome:='denied'; v_reason:='COMMERCE_HELD';
      SELECT array_agg(id ORDER BY id) INTO v_sources FROM account_holds
        WHERE account_id=p_account AND kind='commerce' AND released_at IS NULL;
    END IF;
  END IF;
  IF v_outcome IS NULL AND v_product.offer_code IN ('self_paced','guided_pilot') THEN
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE account_id=p_account AND capability='academy_course'
        AND source_kind='purchase' AND offer_code IN ('self_paced','guided_pilot')
        AND status IN ('active','grace');
    IF coalesce(cardinality(v_sources),0)>0 THEN
      v_outcome:='denied'; v_reason:='ACADEMY_PURCHASE_EXISTS';
    ELSE
      v_support_end:=syntholo_one_year_anniversary_utc(v_receipt.starts_at);
    END IF;
  ELSIF v_outcome IS NULL
    AND v_product.offer_code IN ('operator_club_monthly','operator_club_annual') THEN
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE account_id=p_account AND capability='operator_club'
        AND source_kind='subscription' AND status IN ('active','grace');
    IF coalesce(cardinality(v_sources),0)>0 THEN
      v_outcome:='denied'; v_reason:='CLUB_SUBSCRIPTION_EXISTS';
    ELSIF NOT EXISTS(
      SELECT 1 FROM entitlement_sources a
      JOIN entitlement_grants course ON course.source_registry_id=a.id
        AND course.account_id=a.account_id AND course.capability='academy_course'
        AND course.source_kind='purchase'
        AND course.offer_code IN ('self_paced','guided_pilot')
        AND course.status IN ('active','grace') AND course.starts_at<=p_now
        AND course.ends_at IS NULL
      JOIN entitlement_grants support ON support.source_registry_id=a.id
        AND support.account_id=a.account_id AND support.capability='support'
      WHERE a.id=v_product.academy_source_registry_id
        AND a.account_id=p_account
        AND greatest(support.ends_at,v_product.created_at)=v_receipt.starts_at)
    THEN
      v_outcome:='denied'; v_reason:='CLUB_ACADEMY_PAIR_REQUIRED';
      v_sources:='{}';
    END IF;
  ELSIF v_outcome IS NULL AND v_product.offer_code='business_os'
    AND EXISTS(SELECT 1 FROM entitlement_grants WHERE account_id=p_account
      AND capability='business_os' AND source_kind='subscription'
      AND offer_code='business_os' AND status IN ('active','grace')) THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_SUBSCRIPTION_EXISTS';
  END IF;
  IF v_outcome IS NULL THEN
    IF v_product.offer_code IN ('self_paced','guided_pilot') THEN
      INSERT INTO entitlement_grants(account_id,source_registry_id,source_kind,
        source_id,offer_code,capability,status,starts_at,ends_at,provenance,
        created_at,updated_at)
      VALUES
        (p_account,p_source,v_product.source_kind,v_product.source_id,
          v_product.offer_code,'academy_course','active',v_receipt.starts_at,
          null,'commerce-reconciliation',p_now,p_now),
        (p_account,p_source,v_product.source_kind,v_product.source_id,
          v_product.offer_code,'support','active',v_receipt.starts_at,
          v_support_end,'commerce-reconciliation',p_now,p_now),
        (p_account,p_source,v_product.source_kind,v_product.source_id,
          v_product.offer_code,'circle_write','active',v_receipt.starts_at,
          v_support_end,'commerce-reconciliation',p_now,p_now);
      SELECT id INTO v_owner_membership FROM memberships
        WHERE account_id=p_account AND role='owner' AND status='active';
      IF v_owner_membership IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM seat_reservations WHERE account_id=p_account
            AND membership_id=v_owner_membership AND state='active') THEN
        INSERT INTO seat_reservations(account_id,slot,source_registry_id,state,
          membership_id,created_at,updated_at)
        VALUES(p_account,1,p_source,'active',v_owner_membership,p_now,p_now);
      END IF;
    ELSIF v_product.offer_code IN ('operator_club_monthly','operator_club_annual') THEN
      INSERT INTO entitlement_grants(account_id,source_registry_id,source_kind,
        source_id,offer_code,capability,status,starts_at,ends_at,provenance,
        created_at,updated_at)
      SELECT p_account,p_source,v_product.source_kind,v_product.source_id,
        v_product.offer_code,capability,
        CASE WHEN v_receipt.ends_at<=p_now THEN 'expired' ELSE 'active' END,
        v_receipt.starts_at,v_receipt.ends_at,'commerce-reconciliation',p_now,p_now
      FROM unnest(ARRAY['support','circle_write','operator_club']) capability;
    ELSE
      INSERT INTO entitlement_grants(account_id,source_registry_id,source_kind,
        source_id,offer_code,capability,status,starts_at,ends_at,provenance,
        created_at,updated_at)
      VALUES(p_account,p_source,v_product.source_kind,v_product.source_id,
        v_product.offer_code,'business_os',
        CASE WHEN v_receipt.ends_at<=p_now THEN 'expired' ELSE 'active' END,
        v_receipt.starts_at,v_receipt.ends_at,'commerce-reconciliation',p_now,p_now);
    END IF;
    PERFORM set_config('app.commerce_fulfillment_transition',
      'syntholo-commerce-fulfillment-v1',true);
    UPDATE commerce_fulfillment_receipts SET status='fulfilled',updated_at=p_now
      WHERE source_registry_id=p_source;
    PERFORM set_config('app.commerce_reconciliation_transition',
      'syntholo-commerce-reconciliation-v1',true);
    UPDATE commerce_reconciliations SET status='resolved_fulfilled',
      resolution_code='fulfilled',resolved_at=p_now,updated_at=p_now
      WHERE id=v_receipt.reconciliation_id AND account_id=p_account
        AND target_source_registry_id=p_source
        AND incident_kind='parked_paid_receipt'
        AND status IN ('open','claimed');
    PERFORM set_config('app.commerce_reconciliation_transition','',true);
    PERFORM set_config('app.commerce_fulfillment_transition','',true);
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE source_registry_id=p_source;
    v_outcome:='applied'; v_reason:='PRODUCT_FULFILLMENT_RECONCILED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'fulfillmentStatus','fulfilled','reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'reconcile_product_fulfillment',v_outcome,v_result,
    'product:fulfillment_reconciliation',v_reason,coalesce(v_sources,'{}'),
    p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_reconcile_product_fulfillment(
  uuid,uuid,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_reconcile_product_fulfillment(
  uuid,uuid,text,uuid,text,timestamptz) TO syntholo_staff_api,syntholo_migrator;

CREATE FUNCTION syntholo_redeem_invitation(
  p_account uuid,p_command uuid,p_input_hash text,p_token_hash bytea,
  p_clerk_user text,p_email text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_identity uuid:=gen_random_uuid(); v_membership uuid:=gen_random_uuid();
DECLARE v_token uuid; v_invitation uuid; v_reservation uuid; v_source uuid;
DECLARE v_slot integer; v_email text; v_sources uuid[]:='{}';
DECLARE v_existing_identity boolean:=false;
DECLARE v_constraint text;
BEGIN
  IF p_token_hash IS NULL OR p_clerk_user IS NULL OR p_email IS NULL
    OR octet_length(p_token_hash)<>32 OR octet_length(p_clerk_user) NOT BETWEEN 1 AND 255
    OR lower(btrim(p_email))!~'^[^[:space:]@]+@[^[:space:]@]+$'
    OR octet_length(lower(btrim(p_email))) NOT BETWEEN 3 AND 320 THEN
    RAISE EXCEPTION 'SYNTHOLO_REDEMPTION_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'redeem_invitation',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active') THEN
      RAISE EXCEPTION 'SYNTHOLO_ACCOUNT_INACTIVE' USING ERRCODE='42501';
    END IF;
    IF v_command.outcome='applied' AND NOT EXISTS(
      SELECT 1 FROM memberships m
      JOIN member_identities i ON i.id=m.member_identity_id
        AND i.account_id=m.account_id
      JOIN seat_reservations r ON r.membership_id=m.id
        AND r.account_id=m.account_id AND r.state='active'
      JOIN seat_invitation_token_generations t
        ON t.invitation_id=r.invitation_id AND t.account_id=r.account_id
      WHERE m.id=(v_command.result->>'membershipId')::uuid
        AND i.id=(v_command.result->>'identityId')::uuid
        AND r.id=(v_command.result->>'reservationId')::uuid
        AND m.account_id=p_account AND m.status='active'
        AND i.provider='clerk' AND i.provider_user_id=p_clerk_user
        AND t.token_hash=p_token_hash AND t.consumed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'SYNTHOLO_MEMBERSHIP_INACTIVE' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active') THEN
    v_outcome:='denied'; v_reason:='ACCOUNT_INACTIVE';
  END IF;
  SELECT t.id,t.invitation_id,r.id,r.source_registry_id,r.slot,i.normalized_email
    INTO v_token,v_invitation,v_reservation,v_source,v_slot,v_email
    FROM seat_invitation_token_generations t
    JOIN seat_invitations i ON i.id=t.invitation_id AND i.account_id=t.account_id
    JOIN seat_reservations r ON r.invitation_id=i.id AND r.account_id=i.account_id
    WHERE v_outcome IS NULL AND t.account_id=p_account AND t.token_hash=p_token_hash
      AND t.consumed_at IS NULL AND t.superseded_at IS NULL
      AND t.expires_at>p_now AND r.state='pending';
  IF v_outcome IS NULL AND (NOT FOUND OR v_email<>lower(btrim(p_email))) THEN
    v_outcome:='denied'; v_reason:='INVITATION_INACTIVE';
  ELSIF v_outcome IS NULL THEN
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE source_registry_id=v_source AND account_id=p_account
        AND capability='academy_course' AND source_kind='purchase'
        AND offer_code IN ('self_paced','guided_pilot')
        AND status IN ('active','grace');
    IF coalesce(cardinality(v_sources),0)<>1 THEN
      v_outcome:='denied'; v_reason:='ACADEMY_SOURCE_REQUIRED';
      v_sources:='{}';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    SELECT id INTO v_identity FROM member_identities
      WHERE provider='clerk' AND provider_user_id=p_clerk_user;
    v_existing_identity:=FOUND;
    IF NOT v_existing_identity THEN
      v_identity:=gen_random_uuid(); v_membership:=gen_random_uuid();
    ELSIF NOT EXISTS(SELECT 1 FROM member_identities
        WHERE id=v_identity AND account_id=p_account) THEN
      v_outcome:='denied'; v_reason:='IDENTITY_ACCOUNT_CONFLICT';
    ELSE
      SELECT id INTO v_membership FROM memberships
        WHERE account_id=p_account AND member_identity_id=v_identity;
      IF NOT FOUND OR EXISTS(SELECT 1 FROM memberships
          WHERE id=v_membership AND status='active') THEN
        v_outcome:='denied'; v_reason:='MEMBERSHIP_REACTIVATION_UNAVAILABLE';
      END IF;
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    IF NOT v_existing_identity THEN
      BEGIN
        INSERT INTO member_identities(id,account_id,provider,provider_user_id,email,
          created_at,updated_at)
        VALUES(v_identity,p_account,'clerk',p_clerk_user,lower(btrim(p_email)),p_now,p_now);
      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
        IF v_constraint<>'member_identities_provider_user_unique' THEN RAISE; END IF;
        v_outcome:='denied'; v_reason:='IDENTITY_ACCOUNT_CONFLICT';
      END;
      IF v_outcome IS NULL THEN
        INSERT INTO memberships(id,account_id,member_identity_id,role,status,
          created_at,updated_at)
        VALUES(v_membership,p_account,v_identity,'teammate','active',p_now,p_now);
      END IF;
    ELSIF v_outcome IS NULL THEN
      UPDATE memberships SET status='active',role='teammate',updated_at=p_now
        WHERE id=v_membership AND status='revoked';
    END IF;
    IF v_outcome IS NULL THEN
      UPDATE seat_invitation_token_generations SET consumed_at=p_now WHERE id=v_token;
      UPDATE seat_reservations SET state='active',membership_id=v_membership,
        expires_at=null,updated_at=p_now WHERE id=v_reservation;
      v_outcome:='applied'; v_reason:='INVITATION_REDEMPTION_ALLOWED';
      v_result:=jsonb_build_object('identityId',v_identity,
        'membershipId',v_membership,'reservationId',v_reservation,'slot',v_slot,
        'reasonCode',v_reason);
    END IF;
  END IF;
  IF v_result IS NULL THEN v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'redeem_invitation',v_outcome,v_result,'invitation:redeem',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_redeem_invitation(uuid,uuid,text,bytea,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_redeem_invitation(uuid,uuid,text,bytea,text,text,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_expire_invitation(
  p_account uuid,p_command uuid,p_input_hash text,p_invitation uuid,
  p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_reservation uuid; v_slot integer; v_exp timestamptz;
DECLARE v_sources uuid[]:='{}';
BEGIN
  IF p_invitation IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_INVITATION_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'expire_invitation',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT r.id,r.slot,r.expires_at INTO v_reservation,v_slot,v_exp
    FROM seat_reservations r WHERE r.account_id=p_account
      AND r.invitation_id=p_invitation AND r.state='pending';
  IF NOT FOUND THEN v_outcome:='denied'; v_reason:='INVITATION_INACTIVE';
  ELSIF v_exp>p_now THEN v_outcome:='denied'; v_reason:='INVITATION_NOT_DUE';
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE seat_reservations SET state='expired',updated_at=p_now
      WHERE id=v_reservation;
    v_outcome:='applied'; v_reason:='INVITATION_EXPIRED';
    v_result:=jsonb_build_object('invitationId',p_invitation,
      'reservationId',v_reservation,'slot',v_slot,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'expire_invitation',v_outcome,v_result,'invitation:expiry',v_reason,
    v_sources,p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_expire_invitation(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_expire_invitation(uuid,uuid,text,uuid,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_revoke_seat(
  p_account uuid,p_command uuid,p_input_hash text,p_reservation uuid,
  p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_membership uuid; v_slot integer; v_state text; v_source uuid;
DECLARE v_sources uuid[]:='{}'; v_actor_membership uuid; v_holds uuid[]:='{}';
DECLARE v_boundary text;
BEGIN
  IF p_reservation IS NULL OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  v_actor_membership:=nullif(current_setting('app.membership_id',true),'')::uuid;
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'revoke_seat',p_input_hash,p_now,'syntholo_member_api');
  v_boundary:=syntholo_member_owner_boundary_reason(p_account);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_OWNER_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  END IF;
  SELECT membership_id,slot,state,source_registry_id
    INTO v_membership,v_slot,v_state,v_source FROM seat_reservations
    WHERE v_outcome IS NULL AND id=p_reservation
      AND account_id=p_account AND state IN ('pending','active');
  IF v_outcome IS NULL AND NOT FOUND THEN
    v_outcome:='denied'; v_reason:='SEAT_INACTIVE';
  ELSIF v_membership=v_actor_membership THEN
    v_outcome:='denied'; v_reason:='OWNER_TRANSFER_REQUIRED';
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_holds FROM account_holds
    WHERE account_id=p_account AND kind='seat_changes' AND released_at IS NULL;
  IF v_outcome IS NULL AND v_state='active'
    AND coalesce(cardinality(v_holds),0)>0 THEN
    v_outcome:='denied'; v_reason:='SEAT_CHANGES_HELD'; v_sources:=v_holds;
  END IF;
  IF v_outcome IS NULL THEN
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE source_registry_id=v_source AND capability='academy_course';
    UPDATE seat_reservations SET state='revoked',updated_at=p_now
      WHERE id=p_reservation;
    IF v_membership IS NOT NULL THEN
      UPDATE memberships SET status='revoked',updated_at=p_now
        WHERE id=v_membership AND role='teammate';
    END IF;
    v_outcome:='applied'; v_reason:='SEAT_REVOKED';
    v_result:=jsonb_build_object('reservationId',p_reservation,'slot',v_slot,
      'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,'revoke_seat',
    v_outcome,v_result,'seat:revoke',v_reason,coalesce(v_sources,'{}'),p_now,
    p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_revoke_seat(uuid,uuid,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_revoke_seat(uuid,uuid,text,uuid,text,timestamptz)
  TO syntholo_member_api,syntholo_migrator;

CREATE FUNCTION syntholo_replace_seat(
  p_account uuid,p_command uuid,p_input_hash text,p_target_membership uuid,
  p_email text,p_token_hash bytea,p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_old_reservation uuid; v_reservation uuid:=gen_random_uuid();
DECLARE v_invitation uuid:=gen_random_uuid(); v_slot integer; v_source uuid;
DECLARE v_sources uuid[]:='{}'; v_holds uuid[]:='{}'; v_boundary text;
BEGIN
  IF p_target_membership IS NULL OR p_email IS NULL OR p_token_hash IS NULL
    OR p_reason_input IS NULL OR octet_length(p_token_hash)<>32
    OR lower(btrim(p_email))!~'^[^[:space:]@]+@[^[:space:]@]+$'
    OR octet_length(lower(btrim(p_email))) NOT BETWEEN 3 AND 320
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_REPLACEMENT_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'replace_seat',p_input_hash,p_now,'syntholo_member_api');
  v_boundary:=syntholo_member_owner_boundary_reason(p_account);
  IF v_command.replayed THEN
    IF v_boundary IS NOT NULL THEN
      RAISE EXCEPTION 'SYNTHOLO_OWNER_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF v_boundary IS NOT NULL THEN
    v_outcome:='denied'; v_reason:=v_boundary;
  ELSIF NOT syntholo_member_recent_auth(p_now) THEN
    v_outcome:='denied'; v_reason:='RECENT_AUTH_REQUIRED';
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_holds FROM account_holds
    WHERE account_id=p_account AND kind='seat_changes' AND released_at IS NULL;
  IF v_outcome IS NULL AND coalesce(cardinality(v_holds),0)>0 THEN
    v_outcome:='denied'; v_reason:='SEAT_CHANGES_HELD'; v_sources:=v_holds;
  END IF;
  SELECT r.id,r.slot,r.source_registry_id
    INTO v_old_reservation,v_slot,v_source FROM seat_reservations r
    JOIN memberships m ON m.id=r.membership_id AND m.account_id=r.account_id
    WHERE v_outcome IS NULL AND r.account_id=p_account
      AND m.id=p_target_membership AND m.status='active' AND m.role='teammate'
      AND r.state='active';
  IF v_outcome IS NULL AND NOT FOUND THEN
    v_outcome:='denied'; v_reason:='TEAMMATE_SEAT_REQUIRED';
  END IF;
  IF v_outcome IS NULL THEN
    SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
      WHERE source_registry_id=v_source AND capability='academy_course'
        AND source_kind='purchase' AND offer_code IN ('self_paced','guided_pilot')
        AND status IN ('active','grace');
    IF coalesce(cardinality(v_sources),0)<>1 THEN
      v_outcome:='denied'; v_reason:='ACADEMY_SOURCE_REQUIRED';
      v_sources:='{}';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE memberships SET status='revoked',updated_at=p_now
      WHERE id=p_target_membership;
    UPDATE seat_reservations SET state='revoked',updated_at=p_now
      WHERE id=v_old_reservation;
    INSERT INTO seat_invitations(id,account_id,normalized_email,expires_at,created_at)
      VALUES(v_invitation,p_account,lower(btrim(p_email)),
        p_now+interval '168 hours',p_now);
    INSERT INTO seat_invitation_token_generations(account_id,invitation_id,
      generation,token_hash,expires_at,created_at)
    VALUES(p_account,v_invitation,1,p_token_hash,p_now+interval '168 hours',p_now);
    INSERT INTO seat_reservations(id,account_id,slot,source_registry_id,state,
      invitation_id,expires_at,created_at,updated_at)
    VALUES(v_reservation,p_account,v_slot,v_source,'pending',v_invitation,
      p_now+interval '168 hours',p_now,p_now);
    v_outcome:='applied'; v_reason:='SEAT_REPLACEMENT_ALLOWED';
    v_result:=jsonb_build_object('reservationId',v_reservation,
      'invitationId',v_invitation,'slot',v_slot,
      'expiresAt',p_now+interval '168 hours','reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,'replace_seat',
    v_outcome,v_result,'hold:seat_changes',v_reason,coalesce(v_sources,'{}'),p_now,
    p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_replace_seat(uuid,uuid,text,uuid,text,bytea,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_replace_seat(uuid,uuid,text,uuid,text,bytea,text,timestamptz)
  TO syntholo_member_api,syntholo_migrator;

CREATE FUNCTION syntholo_transfer_ownership(
  p_account uuid,p_command uuid,p_input_hash text,p_target_membership uuid,
  p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_actor_membership uuid; v_sources uuid[]:='{}';
BEGIN
  IF p_target_membership IS NULL OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  v_actor_membership:=nullif(current_setting('app.membership_id',true),'')::uuid;
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'transfer_owner',p_input_hash,p_now,'syntholo_member_api');
  IF v_command.replayed THEN
    IF NOT EXISTS(SELECT 1 FROM accounts a JOIN memberships m ON m.account_id=a.id
      WHERE a.id=p_account AND a.status='active' AND m.id=v_actor_membership
        AND m.member_identity_id=current_setting('app.actor_id',true)::uuid
        AND m.status='active') THEN
      RAISE EXCEPTION 'SYNTHOLO_MEMBER_REQUIRED' USING ERRCODE='42501';
    END IF;
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=p_account AND status='active') THEN
    v_outcome:='denied'; v_reason:='ACCOUNT_INACTIVE';
  ELSIF NOT EXISTS(SELECT 1 FROM memberships m
      WHERE m.id=v_actor_membership AND m.account_id=p_account
        AND m.member_identity_id=current_setting('app.actor_id',true)::uuid
        AND m.status='active') THEN
    v_outcome:='denied'; v_reason:='MEMBER_INACTIVE';
  ELSIF NOT syntholo_member_recent_auth(p_now) THEN
    v_outcome:='denied'; v_reason:='RECENT_AUTH_REQUIRED';
  ELSIF NOT EXISTS(SELECT 1 FROM memberships WHERE id=v_actor_membership
    AND account_id=p_account AND role='owner' AND status='active') THEN
    v_outcome:='denied'; v_reason:='OWNER_REQUIRED';
  ELSIF NOT EXISTS(SELECT 1 FROM memberships m JOIN seat_reservations r
      ON r.membership_id=m.id AND r.account_id=m.account_id AND r.state='active'
    WHERE m.id=p_target_membership AND m.account_id=p_account
      AND m.role='teammate' AND m.status='active') THEN
    v_outcome:='denied'; v_reason:='ACTIVE_TEAMMATE_REQUIRED';
  END IF;
  IF v_outcome IS NULL THEN
    SELECT array_agg(DISTINCT g.id ORDER BY g.id) INTO v_sources
      FROM seat_reservations r JOIN entitlement_grants g
        ON g.source_registry_id=r.source_registry_id
        AND g.account_id=r.account_id AND g.capability='academy_course'
      WHERE r.membership_id IN (v_actor_membership,p_target_membership)
        AND r.state='active';
    UPDATE memberships SET role='teammate',updated_at=p_now
      WHERE id=v_actor_membership;
    UPDATE memberships SET role='owner',updated_at=p_now
      WHERE id=p_target_membership;
    v_outcome:='applied'; v_reason:='OWNERSHIP_TRANSFER_ALLOWED';
    v_result:=jsonb_build_object('previousOwnerMembershipId',v_actor_membership,
      'ownerMembershipId',p_target_membership,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,'transfer_owner',
    v_outcome,v_result,'role:owner',v_reason,coalesce(v_sources,'{}'),p_now,
    p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_transfer_ownership(uuid,uuid,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_transfer_ownership(uuid,uuid,text,uuid,text,timestamptz)
  TO syntholo_member_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION syntholo_release_academy_seats(
  p_account uuid,p_source uuid,p_now timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  UPDATE memberships m SET status='revoked',updated_at=p_now
    WHERE m.account_id=p_account AND m.role='teammate' AND m.status='active'
      AND EXISTS(SELECT 1 FROM seat_reservations r
        WHERE r.account_id=p_account AND r.source_registry_id=p_source
          AND r.membership_id=m.id AND r.state='active');
  UPDATE seat_reservations SET state='revoked',updated_at=p_now
    WHERE account_id=p_account AND source_registry_id=p_source
      AND state IN ('pending','active');
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_release_academy_seats(uuid,uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION syntholo_refund_product(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_reason_input text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_offer text; v_kind text;
DECLARE v_setup_status text; v_source_exists boolean:=false;
DECLARE v_fulfillment_status text;
DECLARE v_linked_club_source uuid; v_linked_club_provider_id text;
DECLARE v_reconciliation_id uuid; v_reconciliation_status text;
DECLARE v_reconciliation_created boolean; v_hold_source uuid;
DECLARE v_expected_paid_through timestamptz; v_linked_status text;
DECLARE v_dispositioned_club_source uuid;
DECLARE v_pending_linked_refund uuid; v_pending_academy_source uuid;
DECLARE v_pending_refund_hold_source uuid;
DECLARE v_linked record; v_linked_incident uuid; v_linked_incident_status text;
DECLARE v_linked_incident_created boolean; v_linked_hold_source uuid;
DECLARE v_has_linked_reconciliation boolean:=false;
BEGIN
  IF p_source IS NULL OR p_reason_input IS NULL
    OR octet_length(btrim(p_reason_input)) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'refund_product',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT offer_code,source_kind INTO v_offer,v_kind FROM entitlement_sources
    WHERE id=p_source AND account_id=p_account;
  v_source_exists:=FOUND;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
    WHERE source_registry_id=p_source AND account_id=p_account;
  SELECT status INTO v_setup_status FROM business_os_setup_receipts
    WHERE source_registry_id=p_source AND account_id=p_account;
  SELECT status INTO v_fulfillment_status FROM commerce_fulfillment_receipts
    WHERE source_registry_id=p_source AND account_id=p_account;
  IF NOT v_source_exists
    OR (coalesce(cardinality(v_sources),0)=0 AND v_setup_status IS NULL
      AND v_fulfillment_status IS NULL) THEN
    v_outcome:='denied'; v_reason:='PRODUCT_SOURCE_NOT_FOUND';
  ELSIF v_kind NOT IN ('purchase','subscription') THEN
    v_outcome:='denied'; v_reason:='COMMERCIAL_SOURCE_REQUIRED';
  ELSIF v_setup_status IN ('refunded','dispute_lost')
    OR v_fulfillment_status IN ('refunded','dispute_lost') OR EXISTS(
      SELECT 1 FROM entitlement_grants WHERE source_registry_id=p_source
        AND status IN ('refunded','revoked')) THEN
    v_outcome:='denied'; v_reason:='PRODUCT_ALREADY_TERMINAL';
  END IF;
  IF v_outcome IS NULL AND v_kind='purchase'
    AND v_offer IN ('self_paced','guided_pilot') THEN
    FOR v_linked IN
      SELECT s.id,s.source_id
      FROM entitlement_sources s
      WHERE s.account_id=p_account
        AND s.source_kind='subscription'
        AND s.offer_code IN ('operator_club_monthly','operator_club_annual')
        AND s.academy_source_registry_id=p_source
        AND (EXISTS(SELECT 1 FROM entitlement_grants g
            WHERE g.source_registry_id=s.id AND g.account_id=p_account
              AND g.capability='operator_club'
              AND g.status IN ('active','grace'))
          OR EXISTS(SELECT 1 FROM commerce_fulfillment_receipts receipt
            WHERE receipt.source_registry_id=s.id
              AND receipt.account_id=p_account
              AND receipt.status='reconciliation')
          OR EXISTS(SELECT 1 FROM commerce_reconciliations pending
            WHERE pending.account_id=p_account
              AND pending.target_source_registry_id=s.id
              AND pending.incident_kind='linked_academy_refund'
              AND pending.status IN ('open','claimed')))
      ORDER BY CASE WHEN EXISTS(SELECT 1 FROM entitlement_grants current_grant
          WHERE current_grant.source_registry_id=s.id
            AND current_grant.account_id=p_account
            AND current_grant.capability='operator_club'
            AND current_grant.status IN ('active','grace'))
        THEN 0 ELSE 1 END,s.created_at,s.id
    LOOP
      IF EXISTS(SELECT 1 FROM club_subscription_cancellations
          WHERE source_registry_id=v_linked.id AND account_id=p_account) THEN
      v_dispositioned_club_source:=v_linked.id;
      PERFORM set_config('app.commerce_fulfillment_transition',
        'syntholo-commerce-fulfillment-v1',true);
      UPDATE commerce_fulfillment_receipts SET status='cancelled',updated_at=p_now
        WHERE account_id=p_account
          AND source_registry_id=v_dispositioned_club_source
          AND status IN ('fulfilled','reconciliation');
      PERFORM set_config('app.commerce_fulfillment_transition','',true);
      UPDATE entitlement_grants SET status='revoked',updated_at=p_now
        WHERE account_id=p_account
          AND source_registry_id=v_dispositioned_club_source
          AND status IN ('active','grace','expired');
      PERFORM set_config('app.commerce_reconciliation_transition',
        'syntholo-commerce-reconciliation-v1',true);
      UPDATE commerce_reconciliations SET status='resolved_manual',
        resolution_code='club_cancelled',resolved_at=p_now,updated_at=p_now
        WHERE id=(SELECT reconciliation_id FROM commerce_fulfillment_receipts
          WHERE source_registry_id=v_dispositioned_club_source)
          AND account_id=p_account
          AND incident_kind='parked_paid_receipt'
          AND status IN ('open','claimed');
      UPDATE commerce_reconciliations SET status='resolved_manual',
        resolution_code='club_cancelled',resolved_at=p_now,updated_at=p_now
        WHERE account_id=p_account AND target_source_registry_id=v_linked.id
          AND incident_kind='linked_academy_refund'
          AND status IN ('open','claimed');
      PERFORM set_config('app.commerce_reconciliation_transition','',true);
      UPDATE account_holds SET released_at=p_now
        WHERE released_at IS NULL AND source_registry_id IN (
          SELECT hs.id FROM account_hold_sources hs
          WHERE hs.account_id=p_account
            AND hs.source_kind='academy_refund_reconciliation'
            AND hs.target_source_registry_id=v_linked.id);
      CONTINUE;
      END IF;
      v_reason:='ACADEMY_REFUND_RECONCILIATION_REQUIRED';
      v_linked_incident:=null; v_linked_incident_status:=null;
      v_linked_incident_created:=false; v_linked_hold_source:=null;
      SELECT r.id,r.status INTO v_linked_incident,v_linked_incident_status
        FROM commerce_reconciliations r
        WHERE r.account_id=p_account
          AND r.target_source_registry_id=v_linked.id
          AND r.incident_kind='linked_academy_refund'
          AND r.status IN ('open','claimed')
        ORDER BY r.created_at,r.id LIMIT 1;
      IF v_linked_incident IS NULL THEN
        SELECT min(ends_at),min(status)
          INTO v_expected_paid_through,v_linked_status
          FROM entitlement_grants
          WHERE source_registry_id=v_linked.id
            AND account_id=p_account;
        IF v_expected_paid_through IS NULL THEN
          SELECT ends_at,status INTO v_expected_paid_through,v_linked_status
            FROM commerce_fulfillment_receipts
            WHERE source_registry_id=v_linked.id
              AND account_id=p_account;
        END IF;
        IF v_linked_status='grace' OR (v_linked_status='expired'
          AND NOT EXISTS(SELECT 1 FROM club_subscription_cancellations
            WHERE source_registry_id=v_linked.id
              AND account_id=p_account)) THEN
          v_expected_paid_through:=
            v_expected_paid_through-interval '168 hours';
        END IF;
        SELECT reconciliation_id,reconciliation_status,created
          INTO v_linked_incident,v_linked_incident_status,
            v_linked_incident_created
          FROM syntholo_open_commerce_reconciliation(
            p_account,'refund_product','subscription',v_linked.source_id,
            replace(p_command::text,'-','')||substr(p_input_hash,1,32),
            v_reason,'linked_academy_refund',
            v_linked.id,v_expected_paid_through,p_now);
      END IF;
      INSERT INTO account_hold_sources(account_id,source_kind,source_id,
        target_source_registry_id,created_at)
      VALUES(p_account,'academy_refund_reconciliation',
        v_linked_incident::text,v_linked.id,p_now)
      ON CONFLICT(source_kind,source_id) DO NOTHING;
      SELECT id INTO v_linked_hold_source FROM account_hold_sources
        WHERE account_id=p_account
          AND source_kind='academy_refund_reconciliation'
          AND source_id=v_linked_incident::text
          AND target_source_registry_id=v_linked.id;
      IF v_linked_hold_source IS NULL THEN
        RAISE EXCEPTION 'SYNTHOLO_ACADEMY_REFUND_RECONCILIATION_INVALID'
          USING ERRCODE='23514';
      END IF;
      INSERT INTO account_holds(account_id,source_registry_id,kind,created_at)
      SELECT p_account,v_linked_hold_source,kind,p_now
        FROM unnest(ARRAY['commerce','seat_changes','business_os_activation']) kind
      ON CONFLICT(source_registry_id,kind) DO NOTHING;
      v_has_linked_reconciliation:=true;
      v_reconciliation_created:=coalesce(v_reconciliation_created,false)
        OR coalesce(v_linked_incident_created,false);
      IF v_reconciliation_id IS NULL THEN
        v_reconciliation_id:=v_linked_incident;
        v_reconciliation_status:=v_linked_incident_status;
        v_linked_club_source:=v_linked.id;
        v_linked_club_provider_id:=v_linked.source_id;
        v_hold_source:=v_linked_hold_source;
      END IF;
    END LOOP;
    IF v_has_linked_reconciliation THEN
      SELECT array_agg(id ORDER BY id) INTO v_sources FROM (
        SELECT id FROM entitlement_grants
          WHERE account_id=p_account
            AND (source_registry_id=p_source OR source_registry_id IN (
              SELECT id FROM entitlement_sources
              WHERE account_id=p_account AND academy_source_registry_id=p_source))
        UNION
        SELECT h.id FROM account_holds h
          JOIN account_hold_sources hs ON hs.id=h.source_registry_id
          WHERE hs.account_id=p_account
            AND hs.source_kind='academy_refund_reconciliation'
            AND hs.target_source_registry_id IN (
              SELECT id FROM entitlement_sources
              WHERE account_id=p_account AND academy_source_registry_id=p_source)
      ) evidence;
      v_outcome:='applied';
      v_result:=jsonb_build_object('refundStatus','reconciliation',
        'sourceRegistryId',p_source,
        'linkedClubSourceRegistryId',v_linked_club_source,
        'reconciliationId',v_reconciliation_id,
        'reconciliationStatus',v_reconciliation_status,
        'reconciliationRequired',v_reconciliation_created,
        'holdSourceRegistryId',v_hold_source,'reasonCode',v_reason);
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    IF v_setup_status IN ('paid','paid_reconciliation') THEN
      PERFORM set_config('app.business_os_setup_transition',
        'syntholo-business-os-setup-v1',true);
      UPDATE business_os_setup_receipts SET status='refunded',updated_at=p_now
        WHERE source_registry_id=p_source;
      PERFORM set_config('app.business_os_setup_transition','',true);
    ELSIF v_fulfillment_status IN ('fulfilled','reconciliation') THEN
      PERFORM set_config('app.commerce_fulfillment_transition',
        'syntholo-commerce-fulfillment-v1',true);
      UPDATE commerce_fulfillment_receipts SET status='refunded',updated_at=p_now
        WHERE source_registry_id=p_source;
      PERFORM set_config('app.commerce_fulfillment_transition','',true);
      UPDATE entitlement_grants SET status='refunded',updated_at=p_now
        WHERE source_registry_id=p_source;
    ELSE
      UPDATE entitlement_grants SET status='refunded',updated_at=p_now
        WHERE source_registry_id=p_source;
    END IF;
    PERFORM set_config('app.commerce_reconciliation_transition',
      'syntholo-commerce-reconciliation-v1',true);
    UPDATE commerce_reconciliations SET status='resolved_refund',
      resolution_code='refund',resolved_at=p_now,updated_at=p_now
      WHERE id=coalesce(
          (SELECT reconciliation_id FROM commerce_fulfillment_receipts
            WHERE source_registry_id=p_source),
          (SELECT reconciliation_id FROM business_os_setup_receipts
            WHERE source_registry_id=p_source))
        AND account_id=p_account AND target_source_registry_id=p_source
        AND incident_kind='parked_paid_receipt'
        AND status IN ('open','claimed');
    PERFORM set_config('app.commerce_reconciliation_transition','',true);
    IF v_kind='purchase' AND v_offer IN ('self_paced','guided_pilot') THEN
      PERFORM syntholo_release_academy_seats(p_account,p_source,p_now);
    END IF;
    IF v_dispositioned_club_source IS NOT NULL THEN
      SELECT array_agg(id ORDER BY id) INTO v_sources
        FROM entitlement_grants
        WHERE account_id=p_account
          AND source_registry_id IN (p_source,v_dispositioned_club_source);
    END IF;
    IF v_kind='subscription'
      AND v_offer IN ('operator_club_monthly','operator_club_annual') THEN
      SELECT r.id,s.academy_source_registry_id,hs.id
        INTO v_pending_linked_refund,v_pending_academy_source,
          v_pending_refund_hold_source
        FROM commerce_reconciliations r
        JOIN entitlement_sources s ON s.id=r.target_source_registry_id
          AND s.account_id=r.account_id
        LEFT JOIN account_hold_sources hs ON hs.account_id=r.account_id
          AND hs.source_kind='academy_refund_reconciliation'
          AND hs.source_id=r.id::text
          AND hs.target_source_registry_id=r.target_source_registry_id
        WHERE r.account_id=p_account
          AND r.target_source_registry_id=p_source
          AND r.incident_kind='linked_academy_refund'
          AND r.status IN ('open','claimed')
        ORDER BY r.created_at,r.id LIMIT 1;
      IF v_pending_linked_refund IS NOT NULL
        AND v_pending_academy_source IS NOT NULL
        AND v_pending_refund_hold_source IS NOT NULL THEN
        UPDATE account_holds SET released_at=p_now
          WHERE source_registry_id=v_pending_refund_hold_source
            AND released_at IS NULL;
        PERFORM set_config('app.commerce_reconciliation_transition',
          'syntholo-commerce-reconciliation-v1',true);
        UPDATE commerce_reconciliations SET status='resolved_refund',
          resolution_code='club_refunded',resolved_at=p_now,updated_at=p_now
          WHERE id=v_pending_linked_refund;
        PERFORM set_config('app.commerce_reconciliation_transition','',true);
        IF NOT EXISTS(SELECT 1 FROM commerce_reconciliations pending
            JOIN entitlement_sources club
              ON club.id=pending.target_source_registry_id
              AND club.account_id=pending.account_id
            WHERE pending.account_id=p_account
              AND pending.incident_kind='linked_academy_refund'
              AND pending.status IN ('open','claimed')
              AND club.academy_source_registry_id=v_pending_academy_source) THEN
          PERFORM set_config('app.commerce_fulfillment_transition',
            'syntholo-commerce-fulfillment-v1',true);
          UPDATE commerce_fulfillment_receipts SET status='refunded',updated_at=p_now
            WHERE account_id=p_account
              AND source_registry_id=v_pending_academy_source
              AND status IN ('fulfilled','reconciliation');
          PERFORM set_config('app.commerce_fulfillment_transition','',true);
          UPDATE entitlement_grants SET status='refunded',updated_at=p_now
            WHERE account_id=p_account
              AND source_registry_id=v_pending_academy_source
              AND status IN ('active','grace','expired');
          PERFORM syntholo_release_academy_seats(
            p_account,v_pending_academy_source,p_now);
        END IF;
        SELECT array_agg(id ORDER BY id) INTO v_sources FROM (
          SELECT id FROM entitlement_grants
            WHERE account_id=p_account
              AND source_registry_id IN (p_source,v_pending_academy_source)
          UNION
          SELECT id FROM account_holds
            WHERE source_registry_id=v_pending_refund_hold_source
        ) evidence;
      END IF;
    END IF;
    v_outcome:='applied'; v_reason:='PRODUCT_REFUND_ALLOWED';
    v_result:=jsonb_build_object('refundStatus','refunded',
      'sourceRegistryId',p_source,'reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'refund_product',v_outcome,v_result,'product:refund',v_reason,
    coalesce(v_sources,'{}'),p_now,p_reason_input);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_refund_product(uuid,uuid,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_refund_product(uuid,uuid,text,uuid,text,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_open_dispute(
  p_account uuid,p_command uuid,p_input_hash text,p_dispute_id text,
  p_target_source uuid,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_hold_source uuid:=gen_random_uuid(); v_sources uuid[]:='{}';
DECLARE v_target_account uuid; v_target_kind text; v_setup_status text;
DECLARE v_fulfillment_status text;
DECLARE v_reconciliation_id uuid;
DECLARE v_reconciliation_status text; v_reconciliation_created boolean;
BEGIN
  IF p_dispute_id IS NULL OR p_target_source IS NULL
    OR octet_length(p_dispute_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'SYNTHOLO_DISPUTE_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'stripe_dispute:'||p_dispute_id,0));
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'open_dispute',p_input_hash,p_now,'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
    WHERE source_registry_id=p_target_source AND account_id=p_account;
  SELECT account_id,source_kind INTO v_target_account,v_target_kind
    FROM entitlement_sources
    WHERE id=p_target_source;
  SELECT status INTO v_setup_status FROM business_os_setup_receipts
    WHERE source_registry_id=p_target_source AND account_id=p_account;
  SELECT status INTO v_fulfillment_status FROM commerce_fulfillment_receipts
    WHERE source_registry_id=p_target_source AND account_id=p_account;
  IF v_target_account IS NULL THEN
    v_outcome:='denied'; v_reason:='PRODUCT_SOURCE_NOT_FOUND';
  ELSIF v_target_account<>p_account THEN
    v_reason:='SOURCE_RECONCILIATION_REQUIRED';
    SELECT reconciliation_id,reconciliation_status,created
      INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
      FROM syntholo_open_commerce_reconciliation(
      p_account,'open_dispute','stripe_dispute',p_dispute_id,p_input_hash,
      v_reason,'provider_source_collision',null,null,p_now);
    v_outcome:='applied'; v_sources:='{}';
    v_result:=jsonb_build_object('reconciliationId',v_reconciliation_id,
      'reconciliationStatus',v_reconciliation_status,
      'reconciliationRequired',v_reconciliation_created,'reasonCode',v_reason);
  ELSIF v_target_kind NOT IN ('purchase','subscription') THEN
    v_outcome:='denied'; v_reason:='COMMERCIAL_SOURCE_REQUIRED';
  ELSIF coalesce(cardinality(v_sources),0)=0 AND v_setup_status IS NULL
    AND v_fulfillment_status IS NULL THEN
    v_outcome:='denied'; v_reason:='PRODUCT_SOURCE_NOT_FOUND';
  ELSIF EXISTS(SELECT 1 FROM account_hold_sources
      WHERE source_kind='stripe_dispute' AND source_id=p_dispute_id) THEN
    v_reason:=CASE
      WHEN EXISTS(SELECT 1 FROM account_hold_sources
        WHERE source_kind='stripe_dispute' AND source_id=p_dispute_id
          AND (account_id<>p_account
            OR target_source_registry_id<>p_target_source))
        THEN 'DISPUTE_RECONCILIATION_REQUIRED'
      ELSE 'DISPUTE_ALREADY_RECORDED' END;
    IF v_reason='DISPUTE_RECONCILIATION_REQUIRED' THEN
      SELECT reconciliation_id,reconciliation_status,created
        INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
        FROM syntholo_open_commerce_reconciliation(
        p_account,'open_dispute','stripe_dispute',p_dispute_id,p_input_hash,
        v_reason,'provider_source_collision',p_target_source,null,p_now);
      v_outcome:='applied'; v_sources:='{}';
      v_result:=jsonb_build_object('reconciliationId',v_reconciliation_id,
        'reconciliationStatus',v_reconciliation_status,
        'reconciliationRequired',v_reconciliation_created,'reasonCode',v_reason);
    ELSE
      v_outcome:='denied';
    END IF;
  END IF;
  IF v_outcome IS NULL THEN
    INSERT INTO account_hold_sources(id,account_id,source_kind,source_id,
      target_source_registry_id,created_at)
    VALUES(v_hold_source,p_account,'stripe_dispute',p_dispute_id,
      p_target_source,p_now);
    INSERT INTO account_holds(account_id,source_registry_id,kind,created_at)
    SELECT p_account,v_hold_source,kind,p_now
      FROM unnest(ARRAY['commerce','seat_changes','business_os_activation']) kind;
    v_outcome:='applied'; v_reason:='DISPUTE_HOLDS_OPENED';
    v_result:=jsonb_build_object('holdSourceRegistryId',v_hold_source,
      'reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,'open_dispute',
    v_outcome,v_result,'dispute:open',v_reason,coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_open_dispute(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_open_dispute(uuid,uuid,text,text,uuid,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_resolve_dispute(
  p_account uuid,p_command uuid,p_input_hash text,p_hold_source uuid,
  p_resolution text,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_target_source uuid; v_offer text; v_source_kind text;
DECLARE v_sources uuid[]:='{}';
DECLARE v_linked_club_source uuid; v_linked_club_provider_id text;
DECLARE v_reconciliation_id uuid; v_reconciliation_status text;
DECLARE v_reconciliation_created boolean; v_follow_up_hold_source uuid;
DECLARE v_superseded_refund_ids uuid[]:='{}';
DECLARE v_linked_paid_through timestamptz; v_linked_status text;
DECLARE v_linked record; v_linked_reconciliation uuid;
DECLARE v_linked_reconciliation_status text; v_linked_created boolean;
DECLARE v_linked_follow_up_hold uuid;
BEGIN
  IF p_hold_source IS NULL OR p_resolution IS NULL
    OR p_resolution NOT IN ('won','lost') THEN
    RAISE EXCEPTION 'SYNTHOLO_DISPUTE_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'resolve_dispute',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT hs.target_source_registry_id,s.offer_code,s.source_kind
    INTO v_target_source,v_offer,v_source_kind
    FROM account_hold_sources hs JOIN entitlement_sources s
      ON s.id=hs.target_source_registry_id AND s.account_id=hs.account_id
    WHERE hs.id=p_hold_source AND hs.account_id=p_account
      AND hs.source_kind='stripe_dispute';
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM account_holds
      WHERE source_registry_id=p_hold_source AND released_at IS NULL) THEN
    v_outcome:='denied'; v_reason:='DISPUTE_NOT_OPEN';
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM (
    SELECT id FROM account_holds WHERE source_registry_id=p_hold_source
    UNION
    SELECT id FROM entitlement_grants WHERE source_registry_id=v_target_source
    UNION
    SELECT g.id FROM entitlement_grants g
      JOIN entitlement_sources s ON s.id=g.source_registry_id
      WHERE s.account_id=p_account
        AND s.academy_source_registry_id=v_target_source
  ) evidence;
  IF v_outcome IS NULL THEN
    UPDATE account_holds SET released_at=p_now
      WHERE source_registry_id=p_hold_source AND released_at IS NULL;
    IF p_resolution='lost' THEN
      SELECT array_agg(r.id ORDER BY r.id) INTO v_superseded_refund_ids
        FROM commerce_reconciliations r
        JOIN entitlement_sources club ON club.id=r.target_source_registry_id
          AND club.account_id=r.account_id
        WHERE r.account_id=p_account
          AND r.incident_kind='linked_academy_refund'
          AND r.status IN ('open','claimed')
          AND club.academy_source_registry_id=v_target_source;
      IF coalesce(cardinality(v_superseded_refund_ids),0)>0 THEN
        UPDATE account_holds h SET released_at=p_now
          FROM account_hold_sources hs
          WHERE hs.id=h.source_registry_id AND hs.account_id=p_account
            AND hs.source_kind='academy_refund_reconciliation'
            AND hs.source_id=ANY(v_superseded_refund_ids::text[])
            AND h.released_at IS NULL;
        PERFORM set_config('app.commerce_reconciliation_transition',
          'syntholo-commerce-reconciliation-v1',true);
        UPDATE commerce_reconciliations SET status='resolved_manual',
          resolution_code='superseded_by_dispute',resolved_at=p_now,
          updated_at=p_now WHERE id=ANY(v_superseded_refund_ids);
        PERFORM set_config('app.commerce_reconciliation_transition','',true);
      END IF;
      UPDATE entitlement_grants SET status='revoked',updated_at=p_now
        WHERE source_registry_id=v_target_source
          AND status IN ('active','grace','expired');
      PERFORM set_config('app.business_os_setup_transition',
        'syntholo-business-os-setup-v1',true);
      UPDATE business_os_setup_receipts SET status='dispute_lost',updated_at=p_now
        WHERE source_registry_id=v_target_source
          AND status IN ('paid','paid_reconciliation');
      PERFORM set_config('app.business_os_setup_transition','',true);
      PERFORM set_config('app.commerce_fulfillment_transition',
        'syntholo-commerce-fulfillment-v1',true);
      UPDATE commerce_fulfillment_receipts SET status='dispute_lost',updated_at=p_now
        WHERE source_registry_id=v_target_source
          AND status IN ('fulfilled','reconciliation');
      PERFORM set_config('app.commerce_fulfillment_transition','',true);
      PERFORM set_config('app.commerce_reconciliation_transition',
        'syntholo-commerce-reconciliation-v1',true);
      UPDATE commerce_reconciliations SET status='resolved_refund',
        resolution_code='dispute_lost',resolved_at=p_now,updated_at=p_now
        WHERE id=coalesce(
            (SELECT reconciliation_id FROM commerce_fulfillment_receipts
              WHERE source_registry_id=v_target_source),
            (SELECT reconciliation_id FROM business_os_setup_receipts
              WHERE source_registry_id=v_target_source))
          AND account_id=p_account
          AND target_source_registry_id=v_target_source
          AND incident_kind='parked_paid_receipt'
          AND status IN ('open','claimed');
      PERFORM set_config('app.commerce_reconciliation_transition','',true);
      IF v_source_kind='purchase'
        AND v_offer IN ('self_paced','guided_pilot') THEN
        PERFORM syntholo_release_academy_seats(
          p_account,v_target_source,p_now);
      END IF;
      IF v_source_kind='purchase'
        AND v_offer IN ('self_paced','guided_pilot') THEN
        FOR v_linked IN
          SELECT s.id,s.source_id
          FROM entitlement_sources s
          WHERE s.account_id=p_account
            AND s.source_kind='subscription'
            AND s.offer_code IN ('operator_club_monthly','operator_club_annual')
            AND s.academy_source_registry_id=v_target_source
            AND (EXISTS(SELECT 1 FROM entitlement_grants g
                WHERE g.source_registry_id=s.id AND g.account_id=p_account
                  AND g.capability='operator_club'
                  AND g.status IN ('active','grace'))
              OR EXISTS(SELECT 1 FROM commerce_fulfillment_receipts receipt
                WHERE receipt.source_registry_id=s.id
                  AND receipt.account_id=p_account
                  AND receipt.status='reconciliation'))
          ORDER BY CASE WHEN EXISTS(SELECT 1 FROM entitlement_grants active_grant
              WHERE active_grant.source_registry_id=s.id
                AND active_grant.account_id=p_account
                AND active_grant.capability='operator_club'
                AND active_grant.status IN ('active','grace'))
            THEN 0 ELSE 1 END,s.created_at,s.id
        LOOP
          SELECT min(ends_at),min(status)
            INTO v_linked_paid_through,v_linked_status
            FROM entitlement_grants
            WHERE source_registry_id=v_linked.id AND account_id=p_account;
          IF v_linked_paid_through IS NULL THEN
            SELECT ends_at,status INTO v_linked_paid_through,v_linked_status
              FROM commerce_fulfillment_receipts
              WHERE source_registry_id=v_linked.id AND account_id=p_account;
          END IF;
          IF v_linked_status='grace' OR (v_linked_status='expired'
            AND NOT EXISTS(SELECT 1 FROM club_subscription_cancellations
              WHERE source_registry_id=v_linked.id AND account_id=p_account)) THEN
            v_linked_paid_through:=v_linked_paid_through-interval '168 hours';
          END IF;
          UPDATE entitlement_grants SET status='revoked',updated_at=p_now
            WHERE source_registry_id=v_linked.id
              AND status IN ('active','grace','expired');
          IF EXISTS(SELECT 1 FROM club_subscription_cancellations
              WHERE source_registry_id=v_linked.id AND account_id=p_account) THEN
            CONTINUE;
          END IF;
          v_reason:='LINKED_CLUB_CANCELLATION_RECONCILIATION_REQUIRED';
          SELECT reconciliation_id,reconciliation_status,created
            INTO v_linked_reconciliation,v_linked_reconciliation_status,
              v_linked_created
            FROM syntholo_open_commerce_reconciliation(
              p_account,'resolve_dispute','subscription',v_linked.source_id,
              p_input_hash,v_reason,'linked_club_cancellation',v_linked.id,
              v_linked_paid_through,p_now);
          INSERT INTO account_hold_sources(account_id,source_kind,source_id,
            target_source_registry_id,created_at)
          VALUES(p_account,'club_cancellation_reconciliation',
            v_linked_reconciliation::text,v_linked.id,p_now)
          ON CONFLICT(source_kind,source_id) DO NOTHING;
          SELECT id INTO v_linked_follow_up_hold FROM account_hold_sources
            WHERE account_id=p_account
              AND source_kind='club_cancellation_reconciliation'
              AND source_id=v_linked_reconciliation::text
              AND target_source_registry_id=v_linked.id;
          IF v_linked_follow_up_hold IS NULL THEN
            RAISE EXCEPTION 'SYNTHOLO_LINKED_CLUB_RECONCILIATION_INVALID'
              USING ERRCODE='23514';
          END IF;
          INSERT INTO account_holds(account_id,source_registry_id,kind,created_at)
          SELECT p_account,v_linked_follow_up_hold,kind,p_now
            FROM unnest(ARRAY['commerce','business_os_activation']) kind
          ON CONFLICT(source_registry_id,kind) DO NOTHING;
          v_reconciliation_created:=coalesce(v_reconciliation_created,false)
            OR coalesce(v_linked_created,false);
          IF v_reconciliation_id IS NULL THEN
            v_reconciliation_id:=v_linked_reconciliation;
            v_reconciliation_status:=v_linked_reconciliation_status;
            v_follow_up_hold_source:=v_linked_follow_up_hold;
            v_linked_club_source:=v_linked.id;
            v_linked_club_provider_id:=v_linked.source_id;
          END IF;
        END LOOP;
      END IF;
    END IF;
    v_outcome:='applied';
    v_reason:=CASE
      WHEN p_resolution='won' THEN 'DISPUTE_WON'
      WHEN v_reconciliation_id IS NOT NULL
        THEN 'DISPUTE_LOST_LINKED_CLUB_CANCELLATION_REQUIRED'
      ELSE 'DISPUTE_LOST' END;
    v_result:=jsonb_build_object('holdSourceRegistryId',p_hold_source,
      'resolution',p_resolution,'reconciliationId',v_reconciliation_id,
      'reconciliationStatus',v_reconciliation_status,
      'reconciliationRequired',coalesce(v_reconciliation_created,false),
      'followUpHoldSourceRegistryId',v_follow_up_hold_source,
      'reasonCode',v_reason);
    IF v_follow_up_hold_source IS NOT NULL THEN
      SELECT array_agg(id ORDER BY id) INTO v_sources FROM (
        SELECT h.id FROM account_holds h
          LEFT JOIN account_hold_sources hs ON hs.id=h.source_registry_id
          WHERE h.source_registry_id=p_hold_source OR (
            hs.account_id=p_account
            AND hs.source_kind='club_cancellation_reconciliation'
            AND hs.target_source_registry_id IN (
              SELECT id FROM entitlement_sources
              WHERE account_id=p_account
                AND academy_source_registry_id=v_target_source))
        UNION
        SELECT g.id FROM entitlement_grants g
          WHERE g.source_registry_id=v_target_source OR g.source_registry_id IN (
            SELECT id FROM entitlement_sources
            WHERE account_id=p_account
              AND academy_source_registry_id=v_target_source)
      ) evidence;
    END IF;
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'resolve_dispute',v_outcome,v_result,'dispute:resolve',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_resolve_dispute(uuid,uuid,text,uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_resolve_dispute(uuid,uuid,text,uuid,text,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_club_payment_failed(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_paid_through timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_grace_end timestamptz;
BEGIN
  IF p_source IS NULL OR p_paid_through IS NULL
    OR p_paid_through<>date_trunc('milliseconds',p_paid_through) THEN
    RAISE EXCEPTION 'SYNTHOLO_CLUB_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'club_payment_failed',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
    WHERE source_registry_id=p_source AND account_id=p_account
      AND offer_code IN ('operator_club_monthly','operator_club_annual');
  IF EXISTS(SELECT 1 FROM commerce_reconciliations
      WHERE account_id=p_account
        AND target_source_registry_id=p_source
        AND incident_kind='linked_academy_refund'
        AND status IN ('open','claimed')) THEN
    v_outcome:='denied'; v_reason:='CLUB_REFUND_RECONCILIATION_HELD';
  ELSIF coalesce(cardinality(v_sources),0)<>3 OR EXISTS(
      SELECT 1 FROM club_subscription_cancellations
        WHERE source_registry_id=p_source AND account_id=p_account)
    OR NOT EXISTS(
      SELECT 1 FROM entitlement_sources club
      JOIN entitlement_grants academy
        ON academy.source_registry_id=club.academy_source_registry_id
        AND academy.account_id=club.account_id
        AND academy.capability='academy_course'
        AND academy.source_kind='purchase'
        AND academy.offer_code IN ('self_paced','guided_pilot')
        AND academy.status IN ('active','grace')
        AND academy.starts_at<=p_now AND academy.ends_at IS NULL
      WHERE club.id=p_source AND club.account_id=p_account
        AND club.source_kind='subscription'
        AND club.offer_code IN ('operator_club_monthly','operator_club_annual'))
    OR EXISTS(
      SELECT 1 FROM entitlement_grants WHERE source_registry_id=p_source
        AND (status<>'active' OR ends_at<>p_paid_through)) THEN
    v_outcome:='denied'; v_reason:='CLUB_ACTIVE_INTERVAL_REQUIRED';
  END IF;
  IF v_outcome IS NULL THEN
    v_grace_end:=p_paid_through+interval '168 hours';
    PERFORM set_config('app.grant_interval_transition',
      'syntholo-grant-interval-v1',true);
    UPDATE entitlement_grants SET
      status=CASE WHEN p_now>=v_grace_end THEN 'expired' ELSE 'grace' END,
      ends_at=v_grace_end,updated_at=p_now
      WHERE source_registry_id=p_source;
    PERFORM set_config('app.grant_interval_transition','',true);
    v_outcome:='applied'; v_reason:=CASE WHEN p_now>=v_grace_end
      THEN 'CLUB_GRACE_ELAPSED' ELSE 'CLUB_GRACE_STARTED' END;
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'graceEndsAt',v_grace_end,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'club_payment_failed',v_outcome,v_result,'club:payment_failure',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_club_payment_failed(uuid,uuid,text,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_club_payment_failed(uuid,uuid,text,uuid,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_club_payment_recovered(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_paid_through timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_old_end timestamptz;
BEGIN
  IF p_source IS NULL OR p_paid_through IS NULL OR p_paid_through<=p_now
    OR p_paid_through<>date_trunc('milliseconds',p_paid_through) THEN
    RAISE EXCEPTION 'SYNTHOLO_CLUB_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'club_payment_recovered',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id),min(ends_at) INTO v_sources,v_old_end
    FROM entitlement_grants WHERE source_registry_id=p_source
      AND account_id=p_account
      AND offer_code IN ('operator_club_monthly','operator_club_annual')
      AND status IN ('active','grace');
  IF EXISTS(SELECT 1 FROM commerce_reconciliations
      WHERE account_id=p_account
        AND target_source_registry_id=p_source
        AND incident_kind='linked_academy_refund'
        AND status IN ('open','claimed')) THEN
    v_outcome:='denied'; v_reason:='CLUB_REFUND_RECONCILIATION_HELD';
  ELSIF coalesce(cardinality(v_sources),0)<>3 OR p_paid_through<=v_old_end
    OR EXISTS(SELECT 1 FROM club_subscription_cancellations
      WHERE source_registry_id=p_source AND account_id=p_account)
    OR NOT EXISTS(
      SELECT 1 FROM entitlement_sources club
      JOIN entitlement_grants academy
        ON academy.source_registry_id=club.academy_source_registry_id
        AND academy.account_id=club.account_id
        AND academy.capability='academy_course'
        AND academy.source_kind='purchase'
        AND academy.offer_code IN ('self_paced','guided_pilot')
        AND academy.status IN ('active','grace')
        AND academy.starts_at<=p_now AND academy.ends_at IS NULL
      WHERE club.id=p_source AND club.account_id=p_account
        AND club.source_kind='subscription'
        AND club.offer_code IN ('operator_club_monthly','operator_club_annual'))
    OR EXISTS(SELECT 1 FROM entitlement_grants
      WHERE source_registry_id=p_source AND status='grace' AND ends_at<=p_now) THEN
    v_outcome:='denied'; v_reason:='CLUB_GRACE_RECOVERY_UNAVAILABLE';
  END IF;
  IF v_outcome IS NULL THEN
    PERFORM set_config('app.grant_interval_transition',
      'syntholo-grant-interval-v1',true);
    UPDATE entitlement_grants SET status='active',ends_at=p_paid_through,
      updated_at=p_now WHERE source_registry_id=p_source;
    PERFORM set_config('app.grant_interval_transition','',true);
    v_outcome:='applied'; v_reason:='CLUB_PAYMENT_RECOVERED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'paidThroughAt',p_paid_through,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'club_payment_recovered',v_outcome,v_result,'club:recovery',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_club_payment_recovered(uuid,uuid,text,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_club_payment_recovered(uuid,uuid,text,uuid,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_club_cancelled(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_paid_through timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_status text; v_old_end timestamptz;
DECLARE v_existing_paid_through timestamptz;
DECLARE v_reconciliation_id uuid;
DECLARE v_provider_source_id text;
DECLARE v_reconciliation_status text; v_reconciliation_created boolean;
DECLARE v_linked_refund_id uuid; v_linked_academy_source uuid;
DECLARE v_linked_refund_hold_source uuid;
BEGIN
  IF p_source IS NULL OR p_paid_through IS NULL
    OR p_paid_through<>date_trunc('milliseconds',p_paid_through) THEN
    RAISE EXCEPTION 'SYNTHOLO_CLUB_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'club_cancelled',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT paid_through_at INTO v_existing_paid_through
    FROM club_subscription_cancellations
    WHERE source_registry_id=p_source AND account_id=p_account;
  SELECT source_id INTO v_provider_source_id FROM entitlement_sources
    WHERE id=p_source AND account_id=p_account AND source_kind='subscription';
  SELECT array_agg(id ORDER BY id),min(status),min(ends_at)
    INTO v_sources,v_status,v_old_end
    FROM entitlement_grants WHERE source_registry_id=p_source
      AND account_id=p_account
      AND offer_code IN ('operator_club_monthly','operator_club_annual')
      AND status IN ('active','grace');
  IF v_existing_paid_through IS NOT NULL THEN
    v_outcome:='applied';
    v_reason:=CASE WHEN v_existing_paid_through=p_paid_through
      THEN 'CLUB_CANCELLATION_ALREADY_SCHEDULED'
      ELSE 'CLUB_CANCELLATION_RECONCILIATION_REQUIRED' END;
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'paidThroughAt',v_existing_paid_through,'reasonCode',v_reason);
    IF v_existing_paid_through<>p_paid_through THEN
      SELECT reconciliation_id,reconciliation_status,created
        INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
        FROM syntholo_open_commerce_reconciliation(
        p_account,'club_cancelled','subscription',v_provider_source_id,p_input_hash,
        v_reason,'provider_source_collision',p_source,null,p_now);
      v_result:=v_result||jsonb_build_object(
        'reconciliationId',v_reconciliation_id,
        'reconciliationStatus',v_reconciliation_status,
        'reconciliationRequired',v_reconciliation_created);
    END IF;
  ELSIF coalesce(cardinality(v_sources),0)<>3
    OR (v_status='active' AND p_paid_through<v_old_end)
    OR (v_status='grace'
      AND p_paid_through<>v_old_end-interval '168 hours') OR EXISTS(
      SELECT 1 FROM entitlement_grants WHERE source_registry_id=p_source
        AND starts_at>=p_paid_through) THEN
    v_outcome:='denied'; v_reason:='CLUB_CANCELLATION_UNAVAILABLE';
  END IF;
  IF v_outcome IS NULL THEN
    INSERT INTO club_subscription_cancellations(source_registry_id,account_id,
      paid_through_at,created_at)
    VALUES(p_source,p_account,p_paid_through,p_now);
    PERFORM set_config('app.grant_interval_transition',
      'syntholo-grant-interval-v1',true);
    UPDATE entitlement_grants SET
      status=CASE WHEN p_paid_through<=p_now THEN 'expired'
        WHEN v_status='grace' THEN 'grace' ELSE 'active' END,
      ends_at=p_paid_through,updated_at=p_now WHERE source_registry_id=p_source;
    PERFORM set_config('app.grant_interval_transition','',true);
    SELECT r.id,s.academy_source_registry_id,hs.id
      INTO v_linked_refund_id,v_linked_academy_source,
        v_linked_refund_hold_source
      FROM commerce_reconciliations r
      JOIN entitlement_sources s ON s.id=r.target_source_registry_id
        AND s.account_id=r.account_id
      LEFT JOIN account_hold_sources hs ON hs.account_id=r.account_id
        AND hs.source_kind='academy_refund_reconciliation'
        AND hs.source_id=r.id::text
        AND hs.target_source_registry_id=r.target_source_registry_id
      WHERE r.account_id=p_account
        AND r.target_source_registry_id=p_source
        AND r.incident_kind='linked_academy_refund'
        AND r.status IN ('open','claimed')
        AND r.expected_paid_through_at=p_paid_through
      ORDER BY r.created_at,r.id LIMIT 1;
    IF v_linked_refund_id IS NOT NULL
      AND v_linked_academy_source IS NOT NULL
      AND v_linked_refund_hold_source IS NOT NULL THEN
      PERFORM set_config('app.commerce_fulfillment_transition',
        'syntholo-commerce-fulfillment-v1',true);
      UPDATE commerce_fulfillment_receipts SET status='cancelled',updated_at=p_now
        WHERE account_id=p_account AND source_registry_id=p_source
          AND status IN ('fulfilled','reconciliation');
      PERFORM set_config('app.commerce_fulfillment_transition','',true);
      UPDATE entitlement_grants SET status='revoked',updated_at=p_now
        WHERE account_id=p_account AND source_registry_id=p_source
          AND status IN ('active','grace','expired');
      UPDATE account_holds SET released_at=p_now
        WHERE source_registry_id=v_linked_refund_hold_source
          AND released_at IS NULL;
      PERFORM set_config('app.commerce_reconciliation_transition',
        'syntholo-commerce-reconciliation-v1',true);
      UPDATE commerce_reconciliations SET status='resolved_manual',
        resolution_code='club_cancelled',resolved_at=p_now,updated_at=p_now
        WHERE id=v_linked_refund_id;
      PERFORM set_config('app.commerce_reconciliation_transition','',true);
      IF NOT EXISTS(SELECT 1 FROM commerce_reconciliations pending
          JOIN entitlement_sources club
            ON club.id=pending.target_source_registry_id
            AND club.account_id=pending.account_id
          WHERE pending.account_id=p_account
            AND pending.incident_kind='linked_academy_refund'
            AND pending.status IN ('open','claimed')
            AND club.academy_source_registry_id=v_linked_academy_source) THEN
        PERFORM set_config('app.commerce_fulfillment_transition',
          'syntholo-commerce-fulfillment-v1',true);
        UPDATE commerce_fulfillment_receipts SET status='refunded',updated_at=p_now
          WHERE account_id=p_account
            AND source_registry_id=v_linked_academy_source
            AND status IN ('fulfilled','reconciliation');
        PERFORM set_config('app.commerce_fulfillment_transition','',true);
        UPDATE entitlement_grants SET status='refunded',updated_at=p_now
          WHERE account_id=p_account
            AND source_registry_id=v_linked_academy_source
            AND status IN ('active','grace','expired');
        PERFORM syntholo_release_academy_seats(
          p_account,v_linked_academy_source,p_now);
      END IF;
      SELECT array_agg(id ORDER BY id) INTO v_sources FROM (
        SELECT id FROM entitlement_grants
          WHERE account_id=p_account
            AND source_registry_id IN (p_source,v_linked_academy_source)
        UNION
        SELECT id FROM account_holds
          WHERE source_registry_id=v_linked_refund_hold_source
      ) evidence;
    END IF;
    v_outcome:='applied'; v_reason:='CLUB_CANCELLATION_SCHEDULED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'paidThroughAt',p_paid_through,'reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'club_cancelled',v_outcome,v_result,'club:cancellation',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_club_cancelled(uuid,uuid,text,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_club_cancelled(uuid,uuid,text,uuid,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_expire_club(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}';
BEGIN
  IF p_source IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_CLUB_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'expire_club',p_input_hash,p_now,'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
    WHERE source_registry_id=p_source AND account_id=p_account
      AND offer_code IN ('operator_club_monthly','operator_club_annual')
      AND status IN ('active','grace') AND ends_at<=p_now
      AND (status='grace' OR EXISTS(
        SELECT 1 FROM club_subscription_cancellations c
        WHERE c.source_registry_id=p_source AND c.account_id=p_account
          AND c.paid_through_at=entitlement_grants.ends_at));
  IF coalesce(cardinality(v_sources),0)<>3 THEN
    v_outcome:='denied'; v_reason:='CLUB_EXPIRY_NOT_DUE';
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE entitlement_grants SET status='expired',updated_at=p_now
      WHERE source_registry_id=p_source;
    v_outcome:='applied'; v_reason:='CLUB_EXPIRED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'expiredCapabilities',jsonb_build_array('support','circle_write',
        'operator_club'),'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,'expire_club',
    v_outcome,v_result,'club:expiry',v_reason,coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_expire_club(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_expire_club(uuid,uuid,text,uuid,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_expire_included_support(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}';
BEGIN
  IF p_source IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_SUPPORT_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'expire_support',p_input_hash,p_now,'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
    WHERE source_registry_id=p_source AND account_id=p_account
      AND source_kind='purchase' AND offer_code IN ('self_paced','guided_pilot')
      AND capability IN ('support','circle_write') AND status='active'
      AND ends_at<=p_now;
  IF coalesce(cardinality(v_sources),0)<>2 THEN
    v_outcome:='denied'; v_reason:='SUPPORT_NOT_DUE';
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE entitlement_grants SET status='expired',updated_at=p_now
      WHERE source_registry_id=p_source
        AND capability IN ('support','circle_write');
    v_outcome:='applied'; v_reason:='INCLUDED_SUPPORT_EXPIRED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'expiredCapabilities',jsonb_build_array('support','circle_write'),
      'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'expire_support',v_outcome,v_result,'support:expiry',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_expire_included_support(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_expire_included_support(uuid,uuid,text,uuid,timestamptz)
  TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION syntholo_business_os_payment_failed(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_paid_through timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_grace_end timestamptz;
BEGIN
  IF p_source IS NULL OR p_paid_through IS NULL
    OR p_paid_through<>date_trunc('milliseconds',p_paid_through) THEN
    RAISE EXCEPTION 'SYNTHOLO_BUSINESS_OS_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'business_os_payment_failed',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
    WHERE source_registry_id=p_source AND account_id=p_account
      AND capability='business_os' AND source_kind='subscription'
      AND offer_code='business_os';
  IF coalesce(cardinality(v_sources),0)<>1 OR EXISTS(
      SELECT 1 FROM business_os_subscription_cancellations
        WHERE source_registry_id=p_source AND account_id=p_account)
    OR EXISTS(SELECT 1 FROM entitlement_grants WHERE source_registry_id=p_source
      AND (status<>'active' OR ends_at<>p_paid_through)) THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_ACTIVE_INTERVAL_REQUIRED';
  END IF;
  IF v_outcome IS NULL THEN
    v_grace_end:=p_paid_through+interval '168 hours';
    PERFORM set_config('app.grant_interval_transition',
      'syntholo-grant-interval-v1',true);
    UPDATE entitlement_grants SET
      status=CASE WHEN p_now>=v_grace_end THEN 'expired' ELSE 'grace' END,
      ends_at=v_grace_end,updated_at=p_now WHERE source_registry_id=p_source;
    PERFORM set_config('app.grant_interval_transition','',true);
    v_outcome:='applied'; v_reason:=CASE WHEN p_now>=v_grace_end
      THEN 'BUSINESS_OS_GRACE_ELAPSED' ELSE 'BUSINESS_OS_GRACE_STARTED' END;
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'graceEndsAt',v_grace_end,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'business_os_payment_failed',v_outcome,v_result,'business_os:payment_failure',
    v_reason,coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_business_os_payment_failed(uuid,uuid,text,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_business_os_payment_failed(uuid,uuid,text,uuid,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_business_os_payment_recovered(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_paid_through timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_old_end timestamptz;
BEGIN
  IF p_source IS NULL OR p_paid_through IS NULL OR p_paid_through<=p_now
    OR p_paid_through<>date_trunc('milliseconds',p_paid_through) THEN
    RAISE EXCEPTION 'SYNTHOLO_BUSINESS_OS_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'business_os_payment_recovered',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id),min(ends_at) INTO v_sources,v_old_end
    FROM entitlement_grants WHERE source_registry_id=p_source
      AND account_id=p_account AND capability='business_os'
      AND source_kind='subscription' AND offer_code='business_os'
      AND status='grace';
  IF coalesce(cardinality(v_sources),0)<>1 OR p_paid_through<=v_old_end
    OR v_old_end<=p_now OR EXISTS(SELECT 1 FROM business_os_subscription_cancellations
      WHERE source_registry_id=p_source AND account_id=p_account) THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_GRACE_RECOVERY_UNAVAILABLE';
  END IF;
  IF v_outcome IS NULL THEN
    PERFORM set_config('app.grant_interval_transition',
      'syntholo-grant-interval-v1',true);
    UPDATE entitlement_grants SET status='active',ends_at=p_paid_through,
      updated_at=p_now WHERE source_registry_id=p_source;
    PERFORM set_config('app.grant_interval_transition','',true);
    v_outcome:='applied'; v_reason:='BUSINESS_OS_PAYMENT_RECOVERED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'paidThroughAt',p_paid_through,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'business_os_payment_recovered',v_outcome,v_result,'business_os:recovery',
    v_reason,coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_business_os_payment_recovered(uuid,uuid,text,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_business_os_payment_recovered(uuid,uuid,text,uuid,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_business_os_renewed(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_paid_through timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_old_end timestamptz;
BEGIN
  IF p_source IS NULL OR p_paid_through IS NULL OR p_paid_through<=p_now
    OR p_paid_through<>date_trunc('milliseconds',p_paid_through) THEN
    RAISE EXCEPTION 'SYNTHOLO_BUSINESS_OS_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'business_os_renewed',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id),min(ends_at) INTO v_sources,v_old_end
    FROM entitlement_grants WHERE source_registry_id=p_source
      AND account_id=p_account AND capability='business_os'
      AND source_kind='subscription' AND offer_code='business_os'
      AND status='active';
  IF coalesce(cardinality(v_sources),0)<>1 OR p_paid_through<=v_old_end THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_RENEWAL_UNAVAILABLE';
  END IF;
  IF v_outcome IS NULL AND EXISTS(
      SELECT 1 FROM business_os_subscription_cancellations
      WHERE source_registry_id=p_source AND account_id=p_account) THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_RENEWAL_UNAVAILABLE';
  END IF;
  IF v_outcome IS NULL THEN
    PERFORM set_config('app.grant_interval_transition',
      'syntholo-grant-interval-v1',true);
    UPDATE entitlement_grants SET ends_at=p_paid_through,updated_at=p_now
      WHERE source_registry_id=p_source;
    PERFORM set_config('app.grant_interval_transition','',true);
    v_outcome:='applied'; v_reason:='BUSINESS_OS_RENEWED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'paidThroughAt',p_paid_through,'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'business_os_renewed',v_outcome,v_result,'business_os:renewal',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_business_os_renewed(uuid,uuid,text,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_business_os_renewed(uuid,uuid,text,uuid,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_business_os_cancelled(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,
  p_paid_through timestamptz,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}'; v_old_end timestamptz; v_status text;
DECLARE v_existing_paid_through timestamptz;
DECLARE v_reconciliation_id uuid;
DECLARE v_provider_source_id text;
DECLARE v_reconciliation_status text; v_reconciliation_created boolean;
BEGIN
  IF p_source IS NULL OR p_paid_through IS NULL
    OR p_paid_through<>date_trunc('milliseconds',p_paid_through) THEN
    RAISE EXCEPTION 'SYNTHOLO_BUSINESS_OS_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'business_os_cancelled',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT paid_through_at INTO v_existing_paid_through
    FROM business_os_subscription_cancellations
    WHERE source_registry_id=p_source AND account_id=p_account;
  SELECT source_id INTO v_provider_source_id FROM entitlement_sources
    WHERE id=p_source AND account_id=p_account AND source_kind='subscription';
  SELECT array_agg(id ORDER BY id),min(ends_at),min(status)
    INTO v_sources,v_old_end,v_status
    FROM entitlement_grants
    WHERE source_registry_id=p_source AND account_id=p_account
      AND capability='business_os' AND source_kind='subscription'
      AND offer_code='business_os' AND status IN ('active','grace')
      AND starts_at<p_paid_through;
  IF v_existing_paid_through IS NOT NULL THEN
    v_outcome:='applied';
    v_reason:=CASE WHEN v_existing_paid_through=p_paid_through
      THEN 'BUSINESS_OS_CANCELLATION_ALREADY_SCHEDULED'
      ELSE 'BUSINESS_OS_CANCELLATION_RECONCILIATION_REQUIRED' END;
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'paidThroughAt',v_existing_paid_through,'reasonCode',v_reason);
    IF v_existing_paid_through<>p_paid_through THEN
      SELECT reconciliation_id,reconciliation_status,created
        INTO v_reconciliation_id,v_reconciliation_status,v_reconciliation_created
        FROM syntholo_open_commerce_reconciliation(
        p_account,'business_os_cancelled','subscription',v_provider_source_id,
        p_input_hash,v_reason,'provider_source_collision',p_source,null,p_now);
      v_result:=v_result||jsonb_build_object(
        'reconciliationId',v_reconciliation_id,
        'reconciliationStatus',v_reconciliation_status,
        'reconciliationRequired',v_reconciliation_created);
    END IF;
  ELSIF coalesce(cardinality(v_sources),0)<>1
    OR (v_status='active' AND p_paid_through<v_old_end)
    OR (v_status='grace'
      AND p_paid_through<>v_old_end-interval '168 hours') THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_CANCELLATION_UNAVAILABLE';
  END IF;
  IF v_outcome IS NULL THEN
    INSERT INTO business_os_subscription_cancellations(source_registry_id,
      account_id,paid_through_at,created_at)
    VALUES(p_source,p_account,p_paid_through,p_now);
    PERFORM set_config('app.grant_interval_transition',
      'syntholo-grant-interval-v1',true);
    UPDATE entitlement_grants SET
      status=CASE WHEN p_paid_through<=p_now THEN 'expired'
        WHEN v_status='grace' THEN 'grace' ELSE 'active' END,
      ends_at=p_paid_through,updated_at=p_now WHERE source_registry_id=p_source;
    PERFORM set_config('app.grant_interval_transition','',true);
    v_outcome:='applied'; v_reason:='BUSINESS_OS_CANCELLATION_SCHEDULED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'paidThroughAt',p_paid_through,'reasonCode',v_reason);
  ELSIF v_result IS NULL THEN
    v_result:=jsonb_build_object('reasonCode',v_reason);
  END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'business_os_cancelled',v_outcome,v_result,'business_os:cancellation',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_business_os_cancelled(uuid,uuid,text,uuid,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_business_os_cancelled(uuid,uuid,text,uuid,timestamptz,timestamptz)
  TO syntholo_system_api,syntholo_migrator;

CREATE FUNCTION syntholo_expire_business_os(
  p_account uuid,p_command uuid,p_input_hash text,p_source uuid,p_now timestamptz)
RETURNS TABLE(replayed boolean,outcome text,result jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE v_command record; v_outcome text; v_reason text; v_result jsonb;
DECLARE v_sources uuid[]:='{}';
BEGIN
  IF p_source IS NULL THEN
    RAISE EXCEPTION 'SYNTHOLO_BUSINESS_OS_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM syntholo_lock_entitlement_graph(p_account);
  SELECT * INTO v_command FROM syntholo_begin_entitlement_command(
    p_account,p_command,'expire_business_os',p_input_hash,p_now,
    'syntholo_system_api');
  IF v_command.replayed THEN
    replayed:=true; outcome:=v_command.outcome; result:=v_command.result;
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_sources FROM entitlement_grants
    WHERE source_registry_id=p_source AND account_id=p_account
      AND capability='business_os' AND status IN ('active','grace')
      AND ends_at<=p_now
      AND (status='grace' OR EXISTS(
        SELECT 1 FROM business_os_subscription_cancellations c
        WHERE c.source_registry_id=p_source AND c.account_id=p_account
          AND c.paid_through_at=entitlement_grants.ends_at));
  IF coalesce(cardinality(v_sources),0)<>1 THEN
    v_outcome:='denied'; v_reason:='BUSINESS_OS_EXPIRY_NOT_DUE';
  END IF;
  IF v_outcome IS NULL THEN
    UPDATE entitlement_grants SET status='expired',updated_at=p_now
      WHERE source_registry_id=p_source;
    v_outcome:='applied'; v_reason:='BUSINESS_OS_EXPIRED';
    v_result:=jsonb_build_object('sourceRegistryId',p_source,
      'expiredCapabilities',jsonb_build_array('business_os'),
      'reasonCode',v_reason);
  ELSE v_result:=jsonb_build_object('reasonCode',v_reason); END IF;
  PERFORM syntholo_finish_entitlement_command(p_account,p_command,
    'expire_business_os',v_outcome,v_result,'business_os:expiry',v_reason,
    coalesce(v_sources,'{}'),p_now);
  replayed:=false; outcome:=v_outcome; result:=v_result; RETURN NEXT;
END;
$fn$;
REVOKE ALL ON FUNCTION syntholo_expire_business_os(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syntholo_expire_business_os(uuid,uuid,text,uuid,timestamptz)
  TO syntholo_system_api,syntholo_migrator;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM syntholo_system_api;
GRANT INSERT ON audit_events,outbox_events TO syntholo_system_api;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON accounts,member_identities,memberships,
  entitlement_sources,entitlement_grants,business_os_setup_receipts,
  commerce_fulfillment_receipts,commerce_reconciliations,
  account_hold_sources,account_holds,
  administrative_grant_restorations,
  club_subscription_cancellations,business_os_subscription_cancellations,
  seat_invitations,seat_invitation_token_generations,seat_reservations,
  entitlement_commands
  FROM syntholo_system_api;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON entitlement_sources,entitlement_grants,
  business_os_setup_receipts,commerce_fulfillment_receipts,
  commerce_reconciliations,account_hold_sources,
  account_holds,administrative_grant_restorations,
  club_subscription_cancellations,business_os_subscription_cancellations,
  seat_invitations,
  seat_invitation_token_generations,seat_reservations,
  access_decision_audit,entitlement_commands FROM PUBLIC;
GRANT ALL PRIVILEGES ON entitlement_sources,entitlement_grants,
  business_os_setup_receipts,commerce_fulfillment_receipts,
  commerce_reconciliations,account_hold_sources,
  account_holds,administrative_grant_restorations,
  club_subscription_cancellations,business_os_subscription_cancellations,
  seat_invitations,
  seat_invitation_token_generations,seat_reservations,
  entitlement_commands
  TO syntholo_migrator;
GRANT SELECT,INSERT ON access_decision_audit TO syntholo_migrator;
GRANT SELECT ON entitlement_grants,account_holds,seat_reservations TO syntholo_member_api;
GRANT INSERT ON access_decision_audit TO syntholo_member_api;
REVOKE SELECT ON entitlement_sources,entitlement_grants,business_os_setup_receipts,
  commerce_fulfillment_receipts,commerce_reconciliations,
  account_hold_sources,account_holds,
  administrative_grant_restorations,club_subscription_cancellations,
  business_os_subscription_cancellations,
  seat_invitations,
  seat_invitation_token_generations,seat_reservations,access_decision_audit
  FROM syntholo_staff_api;
GRANT INSERT ON access_decision_audit TO syntholo_staff_api;
REVOKE UPDATE,DELETE,TRUNCATE ON access_decision_audit FROM PUBLIC,syntholo_migrator,
  syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
REVOKE UPDATE,DELETE,TRUNCATE ON seat_invitations FROM PUBLIC,syntholo_migrator,
  syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
REVOKE UPDATE,DELETE,TRUNCATE ON club_subscription_cancellations
  FROM PUBLIC,syntholo_migrator,syntholo_member_api,syntholo_staff_api,
    syntholo_worker,syntholo_system_api;
REVOKE UPDATE,DELETE,TRUNCATE ON business_os_subscription_cancellations
  FROM PUBLIC,syntholo_migrator,syntholo_member_api,syntholo_staff_api,
    syntholo_worker,syntholo_system_api;
REVOKE UPDATE,DELETE,TRUNCATE ON business_os_setup_receipts
  FROM PUBLIC,syntholo_migrator,syntholo_member_api,syntholo_staff_api,
    syntholo_worker,syntholo_system_api;
REVOKE UPDATE,DELETE,TRUNCATE ON commerce_fulfillment_receipts
  FROM PUBLIC,syntholo_migrator,syntholo_member_api,syntholo_staff_api,
    syntholo_worker,syntholo_system_api;
REVOKE UPDATE,DELETE,TRUNCATE ON commerce_reconciliations
  FROM PUBLIC,syntholo_migrator,syntholo_member_api,syntholo_staff_api,
    syntholo_worker,syntholo_system_api;
REVOKE UPDATE,DELETE,TRUNCATE ON administrative_grant_restorations
  FROM PUBLIC,syntholo_migrator,syntholo_member_api,syntholo_staff_api,
    syntholo_worker,syntholo_system_api;
--> statement-breakpoint
REVOKE UPDATE ON accounts,memberships FROM syntholo_member_api;
GRANT UPDATE(name,updated_at) ON accounts TO syntholo_member_api;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON member_identities,memberships FROM syntholo_member_api;
REVOKE INSERT,DELETE,TRUNCATE ON accounts FROM syntholo_member_api;
--> statement-breakpoint
ALTER TABLE entitlement_sources ENABLE ROW LEVEL SECURITY; ALTER TABLE entitlement_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement_grants ENABLE ROW LEVEL SECURITY; ALTER TABLE entitlement_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE business_os_setup_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_os_setup_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_fulfillment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_fulfillment_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_reconciliations FORCE ROW LEVEL SECURITY;
ALTER TABLE administrative_grant_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE administrative_grant_restorations FORCE ROW LEVEL SECURITY;
ALTER TABLE club_subscription_cancellations ENABLE ROW LEVEL SECURITY; ALTER TABLE club_subscription_cancellations FORCE ROW LEVEL SECURITY;
ALTER TABLE business_os_subscription_cancellations ENABLE ROW LEVEL SECURITY; ALTER TABLE business_os_subscription_cancellations FORCE ROW LEVEL SECURITY;
ALTER TABLE account_hold_sources ENABLE ROW LEVEL SECURITY; ALTER TABLE account_hold_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE account_holds ENABLE ROW LEVEL SECURITY; ALTER TABLE account_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE seat_invitations ENABLE ROW LEVEL SECURITY; ALTER TABLE seat_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE seat_invitation_token_generations ENABLE ROW LEVEL SECURITY; ALTER TABLE seat_invitation_token_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE seat_reservations ENABLE ROW LEVEL SECURITY; ALTER TABLE seat_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE access_decision_audit ENABLE ROW LEVEL SECURITY; ALTER TABLE access_decision_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE entitlement_commands ENABLE ROW LEVEL SECURITY; ALTER TABLE entitlement_commands FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entitlement_grants_member_read ON entitlement_grants FOR SELECT TO syntholo_member_api
  USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
CREATE POLICY account_holds_member_read ON account_holds FOR SELECT TO syntholo_member_api
  USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
CREATE POLICY seat_reservations_member_read ON seat_reservations FOR SELECT TO syntholo_member_api
  USING(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
CREATE POLICY access_decision_member_insert ON access_decision_audit FOR INSERT TO syntholo_member_api
  WITH CHECK(account_id=nullif(current_setting('app.account_id',true),'')::uuid
    AND actor_type='member' AND actor_id=current_setting('app.actor_id',true)
    AND correlation_id=nullif(current_setting('app.correlation_id',true),'')::uuid);
CREATE POLICY accounts_system_scope ON accounts FOR SELECT TO syntholo_system_api
  USING(id=nullif(current_setting('app.account_id',true),'')::uuid);
CREATE POLICY audit_events_system_insert ON audit_events FOR INSERT TO syntholo_system_api
  WITH CHECK(account_id=nullif(current_setting('app.account_id',true),'')::uuid
    AND actor_type='system' AND actor_id=current_setting('app.actor_id',true)
    AND correlation_id=nullif(current_setting('app.correlation_id',true),'')::uuid);
CREATE POLICY outbox_events_system_insert ON outbox_events FOR INSERT TO syntholo_system_api
  WITH CHECK(account_id=nullif(current_setting('app.account_id',true),'')::uuid
    AND actor_type='system' AND actor_id=current_setting('app.actor_id',true)
    AND correlation_id=nullif(current_setting('app.correlation_id',true),'')::uuid
    AND status='pending' AND attempts=0 AND claim_generation=0
    AND worker_id IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL
    AND claim_token IS NULL AND published_at IS NULL AND dead_lettered_at IS NULL
    AND last_error_code IS NULL AND last_error_message IS NULL);
--> statement-breakpoint
CREATE POLICY access_decision_staff_insert ON access_decision_audit FOR INSERT TO syntholo_staff_api
  WITH CHECK(actor_type='staff' AND actor_id=current_setting('app.actor_id',true)
    AND correlation_id=nullif(current_setting('app.correlation_id',true),'')::uuid);
--> statement-breakpoint
CREATE POLICY entitlement_sources_migrator ON entitlement_sources FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY entitlement_grants_migrator ON entitlement_grants FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY business_os_setup_receipts_migrator ON business_os_setup_receipts
  FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY commerce_fulfillment_receipts_migrator
  ON commerce_fulfillment_receipts FOR ALL TO syntholo_migrator
  USING(true) WITH CHECK(true);
CREATE POLICY commerce_reconciliations_migrator
  ON commerce_reconciliations FOR ALL TO syntholo_migrator
  USING(true) WITH CHECK(true);
CREATE POLICY administrative_grant_restorations_migrator
  ON administrative_grant_restorations FOR ALL TO syntholo_migrator
  USING(true) WITH CHECK(true);
CREATE POLICY club_subscription_cancellations_migrator ON club_subscription_cancellations FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY business_os_subscription_cancellations_migrator ON business_os_subscription_cancellations FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY account_hold_sources_migrator ON account_hold_sources FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY account_holds_migrator ON account_holds FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY seat_invitations_migrator ON seat_invitations FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY seat_invitation_tokens_migrator ON seat_invitation_token_generations FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY seat_reservations_migrator ON seat_reservations FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY access_decision_migrator ON access_decision_audit FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
CREATE POLICY entitlement_commands_migrator ON entitlement_commands FOR ALL TO syntholo_migrator USING(true) WITH CHECK(true);
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION syntholo_prevent_identity_update(),syntholo_validate_product_source(uuid),
  syntholo_product_bundle_constraint(),syntholo_validate_owner_and_seat(uuid),
  syntholo_owner_seat_constraint(),syntholo_validate_token_deadline(),
  syntholo_validate_grant_source_identity(),syntholo_guard_grant_transition(),
  syntholo_guard_hold_transition(),syntholo_guard_seat_transition(),
  prevent_entitlement_history_mutation(),syntholo_guard_entitlement_command_history(),
  syntholo_lock_entitlement_graph(uuid),
  syntholo_begin_entitlement_command(uuid,uuid,text,text,timestamptz,text),
  syntholo_complete_entitlement_command(uuid,text,jsonb,timestamptz),
  syntholo_member_entitlement_snapshot(uuid,uuid,uuid)
  TO syntholo_migrator;
