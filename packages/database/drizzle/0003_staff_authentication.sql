CREATE TABLE "staff_sessions" (
  "session_hash" bytea PRIMARY KEY NOT NULL,
  "previous_session_hash" bytea,
  "staff_identity_id" uuid NOT NULL,
  "removed_user_id" text NOT NULL,
  "removed_session_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "provider_roles" text[] NOT NULL,
  "provider_permissions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "token_ciphertext" bytea NOT NULL,
  "token_iv" bytea NOT NULL,
  "token_tag" bytea NOT NULL,
  "key_version" integer NOT NULL,
  "access_token_expires_at" timestamp with time zone NOT NULL,
  "hard_expires_at" timestamp with time zone NOT NULL,
  "authenticated_at" timestamp with time zone NOT NULL,
  "refresh_version" integer DEFAULT 0 NOT NULL,
  "refresh_lease_id" text,
  "refresh_lease_expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_sessions_removed_session_id_unique" UNIQUE("removed_session_id"),
  CONSTRAINT "staff_sessions_staff_identity_id_staff_identities_id_fk"
    FOREIGN KEY ("staff_identity_id") REFERENCES "public"."staff_identities"("id")
    ON DELETE restrict ON UPDATE restrict,
  CONSTRAINT "staff_sessions_hash_length_check" CHECK (octet_length("session_hash") = 32),
  CONSTRAINT "staff_sessions_previous_hash_length_check" CHECK ("previous_session_hash" is null or octet_length("previous_session_hash") = 32),
  CONSTRAINT "staff_sessions_iv_length_check" CHECK (octet_length("token_iv") = 12),
  CONSTRAINT "staff_sessions_tag_length_check" CHECK (octet_length("token_tag") = 16),
  CONSTRAINT "staff_sessions_ciphertext_length_check" CHECK (octet_length("token_ciphertext") between 1 and 140000),
  CONSTRAINT "staff_sessions_key_version_check" CHECK ("key_version" > 0),
  CONSTRAINT "staff_sessions_refresh_version_check" CHECK ("refresh_version" >= 0),
  CONSTRAINT "staff_sessions_roles_check" CHECK (cardinality("provider_roles") = 1 and array_position("provider_roles", NULL) is null),
  CONSTRAINT "staff_sessions_permissions_check" CHECK (array_position("provider_permissions", NULL) is null),
  CONSTRAINT "staff_sessions_expiry_check" CHECK ("hard_expires_at" > "created_at"),
  CONSTRAINT "staff_sessions_lease_pair_check" CHECK (("refresh_lease_id" is null) = ("refresh_lease_expires_at" is null))
);
--> statement-breakpoint
CREATE INDEX "staff_sessions_staff_identity_idx" ON "staff_sessions" ("staff_identity_id");
--> statement-breakpoint
CREATE INDEX "staff_sessions_hard_expiry_idx" ON "staff_sessions" ("hard_expires_at");
--> statement-breakpoint
CREATE INDEX "staff_sessions_active_idx" ON "staff_sessions" ("session_hash", "revoked_at");
--> statement-breakpoint
CREATE INDEX "staff_sessions_previous_hash_idx" ON "staff_sessions" ("previous_session_hash");
--> statement-breakpoint
CREATE TABLE "staff_login_attempts" (
  "state_hash" bytea PRIMARY KEY NOT NULL,
  "browser_nonce_hash" bytea NOT NULL,
  "verifier_ciphertext" bytea NOT NULL,
  "verifier_iv" bytea NOT NULL,
  "verifier_tag" bytea NOT NULL,
  "key_version" integer NOT NULL,
  "prior_session_hash" bytea,
  "return_to" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "staff_login_attempts_browser_nonce_hash_unique" UNIQUE("browser_nonce_hash"),
  CONSTRAINT "staff_login_attempts_state_hash_check" CHECK (octet_length("state_hash") = 32),
  CONSTRAINT "staff_login_attempts_nonce_hash_check" CHECK (octet_length("browser_nonce_hash") = 32),
  CONSTRAINT "staff_login_attempts_prior_hash_check" CHECK ("prior_session_hash" is null or octet_length("prior_session_hash") = 32),
  CONSTRAINT "staff_login_attempts_iv_check" CHECK (octet_length("verifier_iv") = 12),
  CONSTRAINT "staff_login_attempts_tag_check" CHECK (octet_length("verifier_tag") = 16),
  CONSTRAINT "staff_login_attempts_ciphertext_check" CHECK (octet_length("verifier_ciphertext") between 1 and 4096),
  CONSTRAINT "staff_login_attempts_key_version_check" CHECK ("key_version" > 0),
  CONSTRAINT "staff_login_attempts_return_to_check" CHECK (octet_length("return_to") between 1 and 2048),
  CONSTRAINT "staff_login_attempts_expiry_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE INDEX "staff_login_attempts_expiry_idx" ON "staff_login_attempts" ("expires_at");
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "staff_sessions", "staff_login_attempts" FROM PUBLIC;
--> statement-breakpoint
GRANT ALL PRIVILEGES ON TABLE "staff_sessions", "staff_login_attempts" TO syntholo_migrator;
--> statement-breakpoint
GRANT SELECT ON TABLE "staff_sessions" TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.member_actor_for_clerk_user(p_clerk_user_id text)
RETURNS TABLE(actor_id uuid, account_id uuid, membership_id uuid, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT mi.id, mi.account_id, m.id, m.role
  FROM public.member_identities AS mi
  JOIN public.memberships AS m
    ON m.member_identity_id = mi.id AND m.account_id = mi.account_id
  JOIN public.accounts AS a ON a.id = mi.account_id
  WHERE mi.provider = 'clerk'
    AND mi.provider_user_id = p_clerk_user_id
    AND m.status = 'active'
    AND a.status = 'active'
  LIMIT 1
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.member_actor_for_clerk_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.member_actor_for_clerk_user(text) TO syntholo_member_api, syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.cleanup_staff_auth(p_before timestamp with time zone, p_limit integer DEFAULT 500)
RETURNS TABLE(login_attempts_deleted integer, sessions_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  safe_before timestamp with time zone := LEAST(p_before, statement_timestamp());
  deleted_attempts integer := 0;
  deleted_sessions integer := 0;
BEGIN
  IF p_before IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'SYNTHOLO_AUTH_CLEANUP_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  WITH eligible AS (
    SELECT ctid FROM public.staff_login_attempts
    WHERE expires_at <= safe_before
      OR (consumed_at IS NOT NULL AND consumed_at <= safe_before)
    ORDER BY expires_at, state_hash
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.staff_login_attempts
  WHERE ctid IN (SELECT ctid FROM eligible);
  GET DIAGNOSTICS deleted_attempts = ROW_COUNT;

  WITH eligible AS (
    SELECT ctid FROM public.staff_sessions
    WHERE hard_expires_at <= safe_before
      OR (revoked_at IS NOT NULL AND revoked_at <= safe_before)
    ORDER BY hard_expires_at, session_hash
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.staff_sessions
  WHERE ctid IN (SELECT ctid FROM eligible);
  GET DIAGNOSTICS deleted_sessions = ROW_COUNT;

  RETURN QUERY SELECT deleted_attempts, deleted_sessions;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cleanup_staff_auth(timestamp with time zone, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cleanup_staff_auth(timestamp with time zone, integer) TO syntholo_worker, syntholo_migrator;
--> statement-breakpoint
CREATE FUNCTION public.staff_consume_login_attempt(p_state bytea, p_nonce bytea)
RETURNS SETOF public.staff_login_attempts
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  UPDATE public.staff_login_attempts SET consumed_at = statement_timestamp()
  WHERE state_hash = p_state AND browser_nonce_hash = p_nonce
    AND consumed_at IS NULL AND expires_at > statement_timestamp()
  RETURNING *
$function$;
--> statement-breakpoint
CREATE FUNCTION public.staff_rotate_session(
  p_prior bytea, p_hash bytea, p_staff uuid, p_user text, p_sid text,
  p_org text, p_roles text[], p_permissions text[], p_ciphertext bytea,
  p_iv bytea, p_tag bytea, p_key integer, p_access_exp timestamptz,
  p_hard_exp timestamptz, p_auth_time timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_hash IS NULL OR octet_length(p_hash) <> 32
     OR (p_prior IS NOT NULL AND (octet_length(p_prior) <> 32 OR p_hash = p_prior))
     OR p_hard_exp NOT BETWEEN statement_timestamp() + interval '7 hours 59 minutes'
                           AND statement_timestamp() + interval '8 hours'
     OR p_access_exp <= statement_timestamp()
     OR p_auth_time > statement_timestamp() + interval '5 seconds'
     OR cardinality(p_roles) <> 1 THEN
    RETURN false;
  END IF;

  UPDATE public.staff_sessions SET
    previous_session_hash = session_hash, session_hash = p_hash,
    removed_session_id = p_sid,
    provider_roles = p_roles, provider_permissions = p_permissions,
    token_ciphertext = p_ciphertext, token_iv = p_iv, token_tag = p_tag,
    key_version = p_key, access_token_expires_at = p_access_exp,
    hard_expires_at = p_hard_exp, authenticated_at = p_auth_time,
    refresh_version = refresh_version + 1, refresh_lease_id = NULL,
    refresh_lease_expires_at = NULL, updated_at = statement_timestamp()
  WHERE ((p_prior IS NOT NULL AND session_hash = p_prior)
      OR (p_prior IS NULL AND removed_session_id = p_sid))
    AND p_hash <> session_hash
    AND revoked_at IS NULL
    AND hard_expires_at > statement_timestamp()
    AND refresh_lease_id IS NULL
    AND staff_identity_id = p_staff AND removed_user_id = p_user
    AND organization_id = p_org
    AND (p_prior IS NOT NULL OR removed_session_id = p_sid);
  IF FOUND THEN RETURN true; END IF;
  IF p_prior IS NOT NULL THEN RETURN false; END IF;
  INSERT INTO public.staff_sessions (
    session_hash, staff_identity_id, removed_user_id, removed_session_id,
    organization_id, provider_roles, provider_permissions, token_ciphertext,
    token_iv, token_tag, key_version, access_token_expires_at,
    hard_expires_at, authenticated_at)
  VALUES (p_hash, p_staff, p_user, p_sid, p_org, p_roles, p_permissions,
          p_ciphertext, p_iv, p_tag, p_key, p_access_exp, p_hard_exp, p_auth_time);
  RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.staff_create_login_attempt(
  p_state bytea, p_nonce bytea, p_ciphertext bytea, p_iv bytea, p_tag bytea,
  p_key integer, p_prior bytea, p_return_to text, p_expires timestamptz)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_expires <= statement_timestamp()
     OR p_expires > statement_timestamp() + interval '5 minutes' THEN
    RETURN false;
  END IF;
  INSERT INTO public.staff_login_attempts
    (state_hash, browser_nonce_hash, verifier_ciphertext, verifier_iv,
     verifier_tag, key_version, prior_session_hash, return_to, expires_at)
  VALUES (p_state, p_nonce, p_ciphertext, p_iv, p_tag, p_key, p_prior,
          p_return_to, p_expires);
  RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE FUNCTION public.staff_acquire_refresh(
  p_hash bytea, p_version integer, p_lease text, p_lease_seconds integer)
RETURNS SETOF public.staff_sessions
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  UPDATE public.staff_sessions SET refresh_lease_id = p_lease,
    refresh_lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
    updated_at = statement_timestamp()
  WHERE session_hash = p_hash AND refresh_version = p_version
    AND revoked_at IS NULL AND hard_expires_at > statement_timestamp()
    AND (refresh_lease_expires_at IS NULL OR refresh_lease_expires_at <= statement_timestamp())
    AND p_lease_seconds BETWEEN 1 AND 60
  RETURNING *
$function$;
--> statement-breakpoint
CREATE FUNCTION public.staff_complete_refresh(
  p_hash bytea, p_lease text, p_version integer, p_ciphertext bytea,
  p_iv bytea, p_tag bytea, p_key integer, p_access_exp timestamptz,
  p_auth_time timestamptz, p_roles text[], p_permissions text[])
RETURNS SETOF public.staff_sessions
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  UPDATE public.staff_sessions SET token_ciphertext=p_ciphertext,
    token_iv=p_iv, token_tag=p_tag, key_version=p_key,
    access_token_expires_at=p_access_exp,
    provider_roles=p_roles, provider_permissions=p_permissions,
    refresh_version=refresh_version+1, refresh_lease_id=NULL,
    refresh_lease_expires_at=NULL, updated_at=statement_timestamp()
  WHERE session_hash=p_hash AND refresh_lease_id=p_lease
    AND refresh_version=p_version AND revoked_at IS NULL
    AND hard_expires_at > statement_timestamp()
    AND refresh_lease_expires_at > statement_timestamp()
    AND p_access_exp > statement_timestamp()
    AND p_auth_time = authenticated_at
  RETURNING *
$function$;
--> statement-breakpoint
CREATE FUNCTION public.staff_release_refresh(p_hash bytea, p_lease text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  UPDATE public.staff_sessions SET refresh_lease_id=NULL,
    refresh_lease_expires_at=NULL, updated_at=statement_timestamp()
  WHERE session_hash=p_hash AND refresh_lease_id=p_lease AND revoked_at IS NULL
$function$;
--> statement-breakpoint
CREATE FUNCTION public.staff_revoke_session(p_hash bytea)
RETURNS TABLE(removed_session_id text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  UPDATE public.staff_sessions SET revoked_at=coalesce(revoked_at, statement_timestamp()),
    refresh_lease_id=NULL, refresh_lease_expires_at=NULL, updated_at=statement_timestamp()
  WHERE session_hash=p_hash OR previous_session_hash=p_hash
  RETURNING staff_sessions.removed_session_id
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.staff_consume_login_attempt(bytea, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_create_login_attempt(bytea, bytea, bytea, bytea, bytea, integer, bytea, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_rotate_session(bytea, bytea, uuid, text, text, text, text[], text[], bytea, bytea, bytea, integer, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_acquire_refresh(bytea, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_complete_refresh(bytea, text, integer, bytea, bytea, bytea, integer, timestamptz, timestamptz, text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_release_refresh(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_revoke_session(bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.staff_consume_login_attempt(bytea, bytea) TO syntholo_staff_api;
GRANT EXECUTE ON FUNCTION public.staff_create_login_attempt(bytea, bytea, bytea, bytea, bytea, integer, bytea, text, timestamptz) TO syntholo_staff_api;
GRANT EXECUTE ON FUNCTION public.staff_rotate_session(bytea, bytea, uuid, text, text, text, text[], text[], bytea, bytea, bytea, integer, timestamptz, timestamptz, timestamptz) TO syntholo_staff_api;
GRANT EXECUTE ON FUNCTION public.staff_acquire_refresh(bytea, integer, text, integer) TO syntholo_staff_api;
GRANT EXECUTE ON FUNCTION public.staff_complete_refresh(bytea, text, integer, bytea, bytea, bytea, integer, timestamptz, timestamptz, text[], text[]) TO syntholo_staff_api;
GRANT EXECUTE ON FUNCTION public.staff_release_refresh(bytea, text) TO syntholo_staff_api;
GRANT EXECUTE ON FUNCTION public.staff_revoke_session(bytea) TO syntholo_staff_api;
