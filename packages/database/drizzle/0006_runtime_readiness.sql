CREATE FUNCTION public.syntholo_runtime_readiness()
RETURNS TABLE(
  schema_version text,
  migration_count integer,
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
  )
  SELECT
    '0006_runtime_readiness'::text,
    (SELECT count(*)::integer FROM drizzle.__drizzle_migrations),
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
