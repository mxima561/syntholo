-- School waitlist capture. Unique normalized email. Idempotent subscribe via system_api.
--> statement-breakpoint
CREATE TABLE public.waitlist_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  email text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  source text NOT NULL,
  CONSTRAINT waitlist_signups_email_unique UNIQUE (email),
  CONSTRAINT waitlist_signups_email_normalized_check CHECK (
    email = lower(btrim(email))
    AND octet_length(email) BETWEEN 3 AND 254
    AND email ~ '^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    AND position('..' in email) = 0
  ),
  CONSTRAINT waitlist_signups_source_check CHECK (source = 'school'),
  CONSTRAINT waitlist_signups_created_at_check CHECK (
    isfinite(created_at) AND created_at = date_trunc('milliseconds', created_at)
  )
);
--> statement-breakpoint
ALTER TABLE public.waitlist_signups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.waitlist_signups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.waitlist_signups FROM PUBLIC;
--> statement-breakpoint
GRANT ALL ON TABLE public.waitlist_signups TO syntholo_migrator;
--> statement-breakpoint
REVOKE ALL ON TABLE public.waitlist_signups FROM syntholo_member_api, syntholo_staff_api, syntholo_system_api, syntholo_worker;
--> statement-breakpoint
CREATE POLICY waitlist_signups_migrator ON public.waitlist_signups
  FOR ALL TO syntholo_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE FUNCTION public.syntholo_waitlist_subscribe_v1(p_email text, p_source text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE
  normalized text;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp());
  inserted public.waitlist_signups;
  existing public.waitlist_signups;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_source IS DISTINCT FROM 'school' THEN RAISE EXCEPTION 'WAITLIST_SOURCE_INVALID'; END IF;
  IF p_email IS NULL THEN RAISE EXCEPTION 'WAITLIST_EMAIL_INVALID'; END IF;
  normalized := lower(btrim(p_email));
  IF octet_length(normalized) NOT BETWEEN 3 AND 254
    OR normalized !~ '^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    OR position('..' in normalized) > 0
  THEN RAISE EXCEPTION 'WAITLIST_EMAIL_INVALID'; END IF;
  INSERT INTO public.waitlist_signups(email, created_at, source)
  VALUES (normalized, now_at, p_source)
  ON CONFLICT (email) DO NOTHING
  RETURNING * INTO inserted;
  IF inserted.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status','subscribed',
      'email',inserted.email,
      'createdAt',to_char(inserted.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source',inserted.source
    );
  END IF;
  SELECT * INTO existing FROM public.waitlist_signups WHERE email=normalized;
  RETURN jsonb_build_object(
    'status','already-subscribed',
    'email',existing.email,
    'createdAt',to_char(existing.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'source',existing.source
  );
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_waitlist_subscribe_v1(text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_waitlist_subscribe_v1(text,text) TO syntholo_system_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_waitlist_get_by_email_v1(p_email text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE
  normalized text;
  existing public.waitlist_signups;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  IF p_email IS NULL THEN RETURN NULL; END IF;
  normalized := lower(btrim(p_email));
  SELECT * INTO existing FROM public.waitlist_signups WHERE email=normalized;
  IF existing.id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'email',existing.email,
    'createdAt',to_char(existing.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'source',existing.source
  );
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_waitlist_get_by_email_v1(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_waitlist_get_by_email_v1(text) TO syntholo_system_api;
