DROP FUNCTION public.syntholo_runtime_readiness();
--> statement-breakpoint
CREATE FUNCTION public.syntholo_runtime_readiness()
RETURNS TABLE(
  schema_version text,
  migration_count integer,
  migration_hashes text[],
  required_objects text[],
  runtime_role text,
  capability text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $readiness$
  WITH runtime AS (
    SELECT session_user AS role_name,
      CASE
        WHEN pg_has_role(session_user, 'syntholo_member_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_staff_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_worker', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_system_api', 'MEMBER')
          THEN 'syntholo_member_api'
        WHEN pg_has_role(session_user, 'syntholo_staff_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_member_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_worker', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_system_api', 'MEMBER')
          THEN 'syntholo_staff_api'
        WHEN pg_has_role(session_user, 'syntholo_worker', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_member_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_staff_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_system_api', 'MEMBER')
          THEN 'syntholo_worker'
        WHEN pg_has_role(session_user, 'syntholo_system_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_member_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_staff_api', 'MEMBER')
          AND NOT pg_has_role(session_user, 'syntholo_worker', 'MEMBER')
          THEN 'syntholo_system_api'
        WHEN EXISTS (
          SELECT 1 FROM pg_roles
          WHERE rolname = session_user AND rolsuper
        ) THEN 'syntholo_migrator'
        ELSE NULL
      END AS capability_name
  ), required(name, object_oid) AS (
    VALUES
      ('public.access_decision_audit', to_regclass('public.access_decision_audit')),
      ('public.account_hold_sources', to_regclass('public.account_hold_sources')),
      ('public.account_holds', to_regclass('public.account_holds')),
      ('public.accounts', to_regclass('public.accounts')),
      ('public.administrative_grant_restorations', to_regclass('public.administrative_grant_restorations')),
      ('public.audit_events', to_regclass('public.audit_events')),
      ('public.business_os_setup_receipts', to_regclass('public.business_os_setup_receipts')),
      ('public.business_os_subscription_cancellations', to_regclass('public.business_os_subscription_cancellations')),
      ('public.club_subscription_cancellations', to_regclass('public.club_subscription_cancellations')),
      ('public.commerce_fulfillment_receipts', to_regclass('public.commerce_fulfillment_receipts')),
      ('public.commerce_reconciliations', to_regclass('public.commerce_reconciliations')),
      ('public.entitlement_commands', to_regclass('public.entitlement_commands')),
      ('public.entitlement_grants', to_regclass('public.entitlement_grants')),
      ('public.entitlement_sources', to_regclass('public.entitlement_sources')),
      ('public.event_handler_receipts', to_regclass('public.event_handler_receipts')),
      ('public.job_attempts', to_regclass('public.job_attempts')),
      ('public.jobs', to_regclass('public.jobs')),
      ('public.member_identities', to_regclass('public.member_identities')),
      ('public.memberships', to_regclass('public.memberships')),
      ('public.outbox_events', to_regclass('public.outbox_events')),
      ('public.provider_event_receipts', to_regclass('public.provider_event_receipts')),
      ('public.seat_invitation_token_generations', to_regclass('public.seat_invitation_token_generations')),
      ('public.seat_invitations', to_regclass('public.seat_invitations')),
      ('public.seat_reservations', to_regclass('public.seat_reservations')),
      ('public.staff_identities', to_regclass('public.staff_identities')),
      ('public.staff_login_attempts', to_regclass('public.staff_login_attempts')),
      ('public.staff_sessions', to_regclass('public.staff_sessions'))
  ), readiness_owner AS (
    SELECT proowner AS oid
    FROM pg_proc
    WHERE oid = 'public.syntholo_runtime_readiness()'::regprocedure
  )
  SELECT
    '0007_runtime_contract'::text,
    (SELECT count(*)::integer FROM drizzle.__drizzle_migrations),
    coalesce((
      SELECT array_agg(hash ORDER BY created_at)
      FROM drizzle.__drizzle_migrations
    ), ARRAY[]::text[]),
    coalesce((
      SELECT array_agg(required.name ORDER BY required.name)
      FROM required
      JOIN pg_class ON pg_class.oid = required.object_oid
      WHERE pg_class.relowner = (SELECT oid FROM readiness_owner)
    ), ARRAY[]::text[]),
    runtime.role_name::text,
    runtime.capability_name::text
  FROM runtime
  WHERE runtime.capability_name IS NOT NULL;
$readiness$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_runtime_readiness() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_runtime_readiness() TO
  syntholo_migrator,
  syntholo_member_api,
  syntholo_staff_api,
  syntholo_worker,
  syntholo_system_api;
