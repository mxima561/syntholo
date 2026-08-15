CREATE FUNCTION public.syntholo_account_name_is_canonical(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $account_name$
  SELECT value = normalize(value, NFC)
     AND value = btrim(value, ' ')
     AND octet_length(value) BETWEEN 1 AND 255
     AND NOT EXISTS (
       SELECT 1
       FROM generate_series(1, char_length(value)) AS position(i)
       CROSS JOIN LATERAL (
         VALUES (ascii(substr(value, position.i, 1)))
       ) AS scalar(cp)
       WHERE scalar.cp <= 31
          OR scalar.cp BETWEEN 127 AND 159
          OR scalar.cp IN (160, 173, 1564, 5760, 6158, 12288, 65279)
          OR scalar.cp BETWEEN 8192 AND 8207
          OR scalar.cp BETWEEN 8232 AND 8239
          OR scalar.cp BETWEEN 8287 AND 8303
          OR scalar.cp BETWEEN 55296 AND 57343
          OR scalar.cp BETWEEN 64976 AND 65007
          OR mod(scalar.cp, 65536) IN (65534, 65535)
     )
$account_name$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_account_name_is_canonical(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_account_name_is_canonical(text) TO
  syntholo_member_api,
  syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_normalize_account_name_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $normalize_account_name$
BEGIN
  NEW.name := btrim(normalize(NEW.name, NFC), ' ');
  RETURN NEW;
END
$normalize_account_name$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_normalize_account_name_write() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER accounts_normalize_name_write
BEFORE INSERT OR UPDATE OF name ON public.accounts
FOR EACH ROW
EXECUTE FUNCTION public.syntholo_normalize_account_name_write();
--> statement-breakpoint
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_name_canonical_check
  CHECK (public.syntholo_account_name_is_canonical(name))
  NOT VALID;
--> statement-breakpoint
UPDATE public.accounts
SET name = btrim(normalize(name, NFC), ' ')
WHERE name IS DISTINCT FROM btrim(normalize(name, NFC), ' ')
  AND public.syntholo_account_name_is_canonical(
    btrim(normalize(name, NFC), ' ')
  );
--> statement-breakpoint
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.accounts
    WHERE NOT public.syntholo_account_name_is_canonical(name)
  ) THEN
    RAISE EXCEPTION 'SYNTHOLO_0008_ACCOUNT_NAME_PREFLIGHT_FAILED';
  END IF;
END
$preflight$;
--> statement-breakpoint
ALTER TABLE public.accounts
  VALIDATE CONSTRAINT accounts_name_canonical_check;
--> statement-breakpoint
ALTER FUNCTION public.syntholo_runtime_readiness()
  RENAME TO syntholo_runtime_readiness_foundation_v1;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_runtime_readiness_foundation_v1() FROM
  PUBLIC,
  syntholo_migrator,
  syntholo_member_api,
  syntholo_staff_api,
  syntholo_worker,
  syntholo_system_api;
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
  SELECT
    foundation.schema_version,
    7::integer,
    foundation.migration_hashes[1:7],
    foundation.required_objects,
    foundation.runtime_role,
    foundation.capability
  FROM public.syntholo_runtime_readiness_foundation_v1() AS foundation;
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
--> statement-breakpoint
CREATE FUNCTION public.syntholo_account_name_readiness_v1()
RETURNS TABLE(
  contract_version text,
  migration_created_at bigint,
  migration_hash text,
  predicate_ready boolean,
  constraint_ready boolean,
  writer_compatibility_ready boolean,
  acl_ready boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $account_name_readiness$
  WITH account_table AS (
    SELECT oid, relowner
    FROM pg_class
    WHERE oid = 'public.accounts'::regclass
  ), predicate AS (
    SELECT oid, proowner, proacl
    FROM pg_proc
    WHERE oid = 'public.syntholo_account_name_is_canonical(text)'::regprocedure
  ), normalizer AS (
    SELECT oid, proowner, proacl
    FROM pg_proc
    WHERE oid = 'public.syntholo_normalize_account_name_write()'::regprocedure
  ), journal AS (
    SELECT created_at, hash
    FROM drizzle.__drizzle_migrations
    WHERE created_at = 1786669200000
  )
  SELECT
    '0008_account_name.v1'::text,
    journal.created_at,
    journal.hash,
    EXISTS (
      SELECT 1
      FROM predicate, account_table
      WHERE predicate.proowner = account_table.relowner
    ),
    EXISTS (
      SELECT 1
      FROM pg_constraint, account_table
      WHERE pg_constraint.conrelid = account_table.oid
        AND pg_constraint.conname = 'accounts_name_canonical_check'
        AND pg_constraint.contype = 'c'
        AND pg_constraint.convalidated
    ),
    EXISTS (
      SELECT 1
      FROM pg_trigger, account_table, normalizer
      WHERE pg_trigger.tgrelid = account_table.oid
        AND pg_trigger.tgname = 'accounts_normalize_name_write'
        AND NOT pg_trigger.tgisinternal
        AND pg_trigger.tgenabled = 'O'
        AND pg_trigger.tgfoid = normalizer.oid
        AND normalizer.proowner = account_table.relowner
        AND NOT EXISTS (
          SELECT 1
          FROM aclexplode(coalesce(
            normalizer.proacl,
            acldefault('f', normalizer.proowner)
          )) AS privilege
          WHERE privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        )
    ),
    has_function_privilege(
      'syntholo_member_api',
      'public.syntholo_account_name_is_canonical(text)',
      'EXECUTE'
    )
      AND has_function_privilege(
        'syntholo_migrator',
        'public.syntholo_account_name_is_canonical(text)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'syntholo_staff_api',
        'public.syntholo_account_name_is_canonical(text)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'syntholo_worker',
        'public.syntholo_account_name_is_canonical(text)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'syntholo_system_api',
        'public.syntholo_account_name_is_canonical(text)',
        'EXECUTE'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM predicate,
          LATERAL aclexplode(coalesce(
            predicate.proacl,
            acldefault('f', predicate.proowner)
          )) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      )
  FROM journal;
$account_name_readiness$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_account_name_readiness_v1() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_account_name_readiness_v1() TO
  syntholo_migrator,
  syntholo_member_api,
  syntholo_staff_api,
  syntholo_worker,
  syntholo_system_api;
