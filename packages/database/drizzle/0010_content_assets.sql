CREATE TABLE public.content_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'mux' CONSTRAINT content_media_assets_provider_check CHECK(provider='mux'),
  environment_id text NOT NULL,
  provider_asset_id text NOT NULL,
  signed_policy_playback_id text,
  state text NOT NULL DEFAULT 'waiting' CONSTRAINT content_media_assets_state_check CHECK(state IN ('waiting','preparing','ready','errored','deleted')),
  duration_milliseconds bigint,
  aspect_ratio text,
  safe_error_code text,
  readiness_revision integer NOT NULL DEFAULT 0 CONSTRAINT content_media_assets_revision_check CHECK(readiness_revision>=0),
  last_provider_event_at timestamptz(3),
  last_provider_event_id text,
  last_reconciled_at timestamptz(3),
  imported_at timestamptz(3),
  imported_by_staff_id uuid REFERENCES public.staff_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT content_media_assets_environment_asset_unique UNIQUE(environment_id,provider_asset_id),
  CONSTRAINT content_media_assets_environment_playback_unique UNIQUE(environment_id,signed_policy_playback_id),
  CONSTRAINT content_media_assets_identity_check CHECK(octet_length(environment_id) BETWEEN 1 AND 255 AND environment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(provider_asset_id) BETWEEN 1 AND 255 AND provider_asset_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT content_media_assets_signed_playback_check CHECK(signed_policy_playback_id IS NULL OR (octet_length(signed_policy_playback_id) BETWEEN 1 AND 255 AND signed_policy_playback_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')),
  CONSTRAINT content_media_assets_duration_check CHECK(duration_milliseconds IS NULL OR duration_milliseconds BETWEEN 1 AND 86400000),
  CONSTRAINT content_media_assets_aspect_ratio_check CHECK(aspect_ratio IS NULL OR aspect_ratio ~ '^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$'),
  CONSTRAINT content_media_assets_error_check CHECK(safe_error_code IS NULL OR (octet_length(safe_error_code) BETWEEN 1 AND 64 AND safe_error_code ~ '^[A-Z][A-Z0-9_]*$')),
  CONSTRAINT content_media_assets_provider_event_check CHECK((last_provider_event_at IS NULL)=(last_provider_event_id IS NULL) AND (last_provider_event_id IS NULL OR (octet_length(last_provider_event_id) BETWEEN 1 AND 255 AND last_provider_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'))),
  CONSTRAINT content_media_assets_import_check CHECK((imported_at IS NULL)=(imported_by_staff_id IS NULL)),
  CONSTRAINT content_media_assets_time_check CHECK(updated_at>=created_at)
);
--> statement-breakpoint
CREATE TABLE public.content_media_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL,
  provider_track_id text NOT NULL,
  kind text NOT NULL DEFAULT 'captions' CONSTRAINT content_media_tracks_kind_check CHECK(kind='captions'),
  language text NOT NULL CONSTRAINT content_media_tracks_language_check CHECK(language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  label text NOT NULL CONSTRAINT content_media_tracks_label_check CHECK(octet_length(label) BETWEEN 1 AND 100),
  closed_captions boolean NOT NULL,
  source text NOT NULL CONSTRAINT content_media_tracks_source_check CHECK(source IN ('human','mux_generated')),
  state text NOT NULL DEFAULT 'preparing' CONSTRAINT content_media_tracks_state_check CHECK(state IN ('preparing','ready','errored','deleted')),
  safe_error_code text,
  readiness_revision integer NOT NULL DEFAULT 0 CONSTRAINT content_media_tracks_revision_check CHECK(readiness_revision>=0),
  last_provider_event_at timestamptz(3),
  last_provider_event_id text,
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  CONSTRAINT content_media_tracks_asset_fk FOREIGN KEY(media_asset_id) REFERENCES public.content_media_assets(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT content_media_tracks_asset_provider_track_unique UNIQUE(media_asset_id,provider_track_id),
  CONSTRAINT content_media_tracks_identity_check CHECK(octet_length(provider_track_id) BETWEEN 1 AND 255 AND provider_track_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CONSTRAINT content_media_tracks_error_check CHECK(safe_error_code IS NULL OR (octet_length(safe_error_code) BETWEEN 1 AND 64 AND safe_error_code ~ '^[A-Z][A-Z0-9_]*$')),
  CONSTRAINT content_media_tracks_provider_event_check CHECK((last_provider_event_at IS NULL)=(last_provider_event_id IS NULL) AND (last_provider_event_id IS NULL OR (octet_length(last_provider_event_id) BETWEEN 1 AND 255 AND last_provider_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'))),
  CONSTRAINT content_media_tracks_time_check CHECK(updated_at>=created_at)
);
--> statement-breakpoint
ALTER TABLE public.lesson_drafts ADD CONSTRAINT lesson_drafts_media_asset_fk FOREIGN KEY(media_asset_id) REFERENCES public.content_media_assets(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.lesson_versions ADD CONSTRAINT lesson_versions_media_asset_fk FOREIGN KEY(media_asset_id) REFERENCES public.content_media_assets(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.provider_event_receipts ADD CONSTRAINT provider_event_receipts_mux_safe_payload_check CHECK(provider<>'mux' OR (payload - ARRAY['eventType','environmentId','objectKind','objectId','outcomeCode']::text[]='{}'::jsonb AND octet_length(payload::text)<=2048));
--> statement-breakpoint
CREATE FUNCTION public.syntholo_mux_state_rank(p_state text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $f$
  SELECT CASE p_state WHEN 'waiting' THEN 1 WHEN 'preparing' THEN 2 WHEN 'ready' THEN 3 WHEN 'errored' THEN 4 WHEN 'deleted' THEN 5 ELSE 0 END
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_mux_state_rank(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_mux_apply_event_v1(
  p_expected_environment_id text,p_event_id text,p_event_type text,p_environment_id text,p_occurred_at timestamptz,
  p_provider_asset_id text,p_asset_state text,p_signed_policy_playback_id text,p_duration_milliseconds bigint,p_aspect_ratio text,
  p_provider_track_id text,p_track_state text,p_language text,p_label text,p_closed_captions boolean,p_source text,p_safe_error_code text DEFAULT NULL
) RETURNS TABLE(outcome text,media_asset_id uuid,asset_revision integer,track_revision integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE
  receipt public.provider_event_receipts%ROWTYPE;
  asset public.content_media_assets%ROWTYPE;
  track public.content_media_tracks%ROWTYPE;
  actor text;
  correlation uuid;
  occurred timestamptz(3):=date_trunc('milliseconds',p_occurred_at);
  is_track boolean:=p_event_type LIKE 'video.asset.track.%';
  known boolean:=p_event_type IN ('video.asset.created','video.asset.ready','video.asset.errored','video.asset.updated','video.asset.deleted','video.asset.track.created','video.asset.track.ready','video.asset.track.errored','video.asset.track.deleted');
  should_apply boolean:=false;
  changed boolean:=false;
  reconcile boolean:=false;
  event_uuid uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_system_api');
  actor:=nullif(current_setting('app.actor_id',true),'');
  correlation:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  IF current_setting('app.actor_kind',true)<>'system' OR actor IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'MUX_SYSTEM_CONTEXT_REQUIRED'; END IF;
  IF p_expected_environment_id IS NULL OR p_environment_id IS DISTINCT FROM p_expected_environment_id THEN RAISE EXCEPTION 'MUX_ENVIRONMENT_INVALID'; END IF;
  IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' OR p_event_type IS NULL OR p_event_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' OR (p_provider_asset_id IS NOT NULL AND p_provider_asset_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$') OR occurred IS NULL OR NOT isfinite(occurred) THEN RAISE EXCEPTION 'MUX_EVENT_INVALID'; END IF;
  IF known AND (p_provider_asset_id IS NULL OR (is_track AND (p_provider_track_id IS NULL OR p_track_state IS NULL OR p_track_state NOT IN ('preparing','ready','errored','deleted') OR p_language IS NULL OR p_language !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' OR p_label IS NULL OR octet_length(p_label) NOT BETWEEN 1 AND 100 OR p_closed_captions IS NULL OR p_source IS NULL OR p_source NOT IN ('human','mux_generated'))) OR (NOT is_track AND (p_asset_state IS NULL OR p_asset_state NOT IN ('waiting','preparing','ready','errored','deleted')))) THEN RAISE EXCEPTION 'MUX_EVENT_INVALID'; END IF;
  INSERT INTO public.provider_event_receipts(provider,provider_event_id,status,payload,received_at)
  VALUES('mux',p_event_id,'processing',jsonb_build_object('eventType',p_event_type,'environmentId',p_environment_id,'objectKind',CASE WHEN NOT known THEN 'unknown' WHEN is_track THEN 'track' ELSE 'asset' END,'objectId',CASE WHEN NOT known THEN p_event_id WHEN is_track THEN p_provider_track_id ELSE p_provider_asset_id END),date_trunc('milliseconds',clock_timestamp()))
  ON CONFLICT(provider,provider_event_id) DO NOTHING;
  SELECT * INTO receipt FROM public.provider_event_receipts WHERE provider='mux' AND provider_event_id=p_event_id FOR UPDATE;
  IF receipt.status='processed' THEN
    SELECT a.* INTO asset FROM public.content_media_assets a WHERE a.environment_id=p_environment_id AND a.provider_asset_id=p_provider_asset_id;
    RETURN QUERY SELECT 'duplicate'::text,asset.id,asset.readiness_revision,NULL::integer; RETURN;
  END IF;
  IF receipt.status NOT IN ('processing','received','failed') THEN RAISE EXCEPTION 'MUX_RECEIPT_STATE_INVALID'; END IF;
  IF NOT known THEN
    UPDATE public.provider_event_receipts SET status='processed',processed_at=date_trunc('milliseconds',clock_timestamp()),last_error_code=NULL,payload=payload||jsonb_build_object('outcomeCode','IGNORED_TYPE') WHERE id=receipt.id;
    RETURN QUERY SELECT 'ignored'::text,NULL::uuid,NULL::integer,NULL::integer; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:mux:asset:'||p_environment_id||':'||p_provider_asset_id,0));
  INSERT INTO public.content_media_assets(provider,environment_id,provider_asset_id,state,readiness_revision,created_at,updated_at)
  VALUES('mux',p_environment_id,p_provider_asset_id,'waiting',0,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()))
  ON CONFLICT(environment_id,provider_asset_id) DO NOTHING;
  SELECT * INTO asset FROM public.content_media_assets a WHERE a.environment_id=p_environment_id AND a.provider_asset_id=p_provider_asset_id FOR UPDATE;
  IF NOT is_track THEN
    should_apply:=asset.last_provider_event_at IS NULL OR occurred>asset.last_provider_event_at OR (occurred=asset.last_provider_event_at AND public.syntholo_mux_state_rank(p_asset_state)>public.syntholo_mux_state_rank(asset.state));
    reconcile:=asset.last_provider_event_at IS NOT NULL AND occurred=asset.last_provider_event_at AND ROW(p_asset_state,p_signed_policy_playback_id,p_duration_milliseconds,p_aspect_ratio,p_safe_error_code) IS DISTINCT FROM ROW(asset.state,asset.signed_policy_playback_id,asset.duration_milliseconds,asset.aspect_ratio,asset.safe_error_code);
    IF should_apply THEN
      changed:=ROW(asset.state,asset.signed_policy_playback_id,asset.duration_milliseconds,asset.aspect_ratio,asset.safe_error_code) IS DISTINCT FROM ROW(p_asset_state,p_signed_policy_playback_id,p_duration_milliseconds,p_aspect_ratio,p_safe_error_code);
      UPDATE public.content_media_assets SET state=p_asset_state,signed_policy_playback_id=p_signed_policy_playback_id,duration_milliseconds=p_duration_milliseconds,aspect_ratio=p_aspect_ratio,safe_error_code=p_safe_error_code,readiness_revision=readiness_revision+CASE WHEN changed THEN 1 ELSE 0 END,last_provider_event_at=occurred,last_provider_event_id=p_event_id,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=asset.id RETURNING * INTO asset;
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('content:mux:track:'||p_environment_id||':'||p_provider_asset_id||':'||p_provider_track_id,0));
    INSERT INTO public.content_media_tracks(media_asset_id,provider_track_id,kind,language,label,closed_captions,source,state,readiness_revision,created_at,updated_at)
    VALUES(asset.id,p_provider_track_id,'captions',p_language,p_label,p_closed_captions,p_source,'preparing',0,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()))
    ON CONFLICT(media_asset_id,provider_track_id) DO NOTHING;
    SELECT * INTO track FROM public.content_media_tracks t WHERE t.media_asset_id=asset.id AND t.provider_track_id=p_provider_track_id FOR UPDATE;
    should_apply:=track.last_provider_event_at IS NULL OR occurred>track.last_provider_event_at OR (occurred=track.last_provider_event_at AND public.syntholo_mux_state_rank(p_track_state)>public.syntholo_mux_state_rank(track.state));
    reconcile:=track.last_provider_event_at IS NOT NULL AND occurred=track.last_provider_event_at AND ROW(p_track_state,p_language,p_label,p_closed_captions,p_source,p_safe_error_code) IS DISTINCT FROM ROW(track.state,track.language,track.label,track.closed_captions,track.source,track.safe_error_code);
    IF should_apply THEN
      changed:=ROW(track.state,track.language,track.label,track.closed_captions,track.source,track.safe_error_code) IS DISTINCT FROM ROW(p_track_state,p_language,p_label,p_closed_captions,p_source,p_safe_error_code);
      UPDATE public.content_media_tracks SET state=p_track_state,language=p_language,label=p_label,closed_captions=p_closed_captions,source=p_source,safe_error_code=p_safe_error_code,readiness_revision=readiness_revision+CASE WHEN changed THEN 1 ELSE 0 END,last_provider_event_at=occurred,last_provider_event_id=p_event_id,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=track.id RETURNING * INTO track;
      IF changed THEN UPDATE public.content_media_assets SET readiness_revision=readiness_revision+1,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=asset.id RETURNING * INTO asset; END IF;
    END IF;
  END IF;
  IF reconcile THEN
    INSERT INTO public.jobs(account_id,source_actor_type,source_actor_id,correlation_id,queue,type,idempotency_key,payload,status,priority,attempts,max_attempts,run_at,claim_generation,created_at,updated_at)
    VALUES(NULL,'system',actor,correlation,'content','content.mux_reconcile.v1','content-mux-reconcile:'||asset.id::text||':'||asset.readiness_revision::text,jsonb_build_object('mediaAssetId',asset.id::text,'requestedRevision',asset.readiness_revision),'queued',0,0,5,date_trunc('milliseconds',clock_timestamp()),0,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp())) ON CONFLICT(idempotency_key) DO NOTHING;
  END IF;
  IF changed THEN
    event_uuid:=gen_random_uuid();
    INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),NULL,'system',actor,'content_media_state_changed',CASE WHEN is_track THEN 'content_media_track' ELSE 'content_media_asset' END,CASE WHEN is_track THEN track.id::text ELSE asset.id::text END,correlation,jsonb_build_object('eventId',p_event_id,'state',CASE WHEN is_track THEN track.state ELSE asset.state END,'readinessRevision',CASE WHEN is_track THEN track.readiness_revision ELSE asset.readiness_revision END),date_trunc('milliseconds',clock_timestamp()));
    INSERT INTO public.outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) VALUES(event_uuid,NULL,'content.media_state_changed.v1',asset.id::text,jsonb_build_object('mediaAssetId',asset.id::text,'objectKind',CASE WHEN is_track THEN 'track' ELSE 'asset' END,'state',CASE WHEN is_track THEN track.state ELSE asset.state END,'readinessRevision',CASE WHEN is_track THEN track.readiness_revision ELSE asset.readiness_revision END),1,'pending',0,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp()),'system',actor,correlation,10,0);
  END IF;
  UPDATE public.provider_event_receipts SET status='processed',processed_at=date_trunc('milliseconds',clock_timestamp()),last_error_code=NULL,payload=payload||jsonb_build_object('outcomeCode',CASE WHEN changed THEN 'APPLIED' WHEN should_apply THEN 'ORDERED_NO_CHANGE' ELSE 'STALE' END) WHERE id=receipt.id;
  RETURN QUERY SELECT CASE WHEN changed THEN 'applied' WHEN should_apply THEN 'ordered_no_change' ELSE 'stale' END,asset.id,asset.readiness_revision,CASE WHEN is_track THEN track.readiness_revision ELSE NULL END;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_mux_apply_event_v1(text,text,text,text,timestamptz,text,text,text,bigint,text,text,text,text,text,boolean,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_mux_apply_event_v1(text,text,text,text,timestamptz,text,text,text,bigint,text,text,text,text,text,boolean,text,text) TO syntholo_system_api;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.syntholo_attest_runtime_capability(p_expected text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE login_state record; capability_state record;
DECLARE reachable_count integer; expected_count integer;
DECLARE membership_options_safe boolean;
BEGIN
  IF p_expected IS NULL OR p_expected NOT IN ('syntholo_member_api','syntholo_staff_api','syntholo_system_api','syntholo_worker') THEN RAISE EXCEPTION 'SYNTHOLO_RUNTIME_CAPABILITY_INVALID' USING ERRCODE='42501'; END IF;
  SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig INTO login_state FROM pg_roles WHERE rolname=session_user;
  SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig INTO capability_state FROM pg_roles WHERE rolname=p_expected;
  WITH RECURSIVE memberships AS (
    SELECT am.roleid,am.inherit_option,am.set_option,am.admin_option,ARRAY[login_state.oid,am.roleid]::oid[] path FROM pg_auth_members am WHERE am.member=login_state.oid
    UNION ALL
    SELECT am.roleid,am.inherit_option,am.set_option,am.admin_option,parent.path||am.roleid FROM pg_auth_members am JOIN memberships parent ON parent.roleid=am.member WHERE NOT am.roleid=ANY(parent.path)
  )
  SELECT count(DISTINCT roleid)::int,count(DISTINCT roleid) FILTER(WHERE roleid=capability_state.oid)::int,coalesce(bool_and(inherit_option AND NOT set_option AND NOT admin_option),false)
    INTO reachable_count,expected_count,membership_options_safe FROM memberships;
  IF login_state.oid IS NULL OR capability_state.oid IS NULL
    OR NOT login_state.rolcanlogin OR login_state.rolsuper OR login_state.rolcreatedb OR login_state.rolcreaterole OR login_state.rolreplication OR login_state.rolbypassrls OR login_state.rolconfig IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=login_state.oid)
    OR reachable_count<>1 OR expected_count<>1 OR NOT membership_options_safe
    OR capability_state.rolcanlogin OR capability_state.rolsuper OR capability_state.rolcreatedb OR capability_state.rolcreaterole OR capability_state.rolreplication OR capability_state.rolbypassrls OR capability_state.rolconfig IS NOT NULL
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
    OR has_database_privilege(session_user,current_database(),'CREATE') OR has_database_privilege(session_user,current_database(),'TEMP')
    OR has_database_privilege(p_expected,current_database(),'CREATE') OR has_database_privilege(p_expected,current_database(),'TEMP')
    OR has_schema_privilege(session_user,'public','CREATE') OR has_schema_privilege(p_expected,'public','CREATE')
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_namespace n WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND ((n.nspname='public' AND (NOT has_schema_privilege(p_expected,n.oid,'USAGE') OR has_schema_privilege(p_expected,n.oid,'CREATE'))) OR (n.nspname<>'public' AND (has_schema_privilege(p_expected,n.oid,'USAGE') OR has_schema_privilege(p_expected,n.oid,'CREATE'))))))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) privilege(name)
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(p_expected,c.oid,privilege.name)
        AND NOT(n.nspname='public' AND c.relname IN ('audit_events','outbox_events') AND privilege.name='INSERT')))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) privilege(name)
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND c.relkind IN ('r','p','v','m','f') AND has_any_column_privilege(p_expected,c.oid,privilege.name)
        AND NOT(n.nspname='public' AND c.relname IN ('audit_events','outbox_events') AND privilege.name='INSERT')))
    OR (p_expected='syntholo_system_api' AND EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND (
        (has_function_privilege(p_expected,p.oid,'EXECUTE') AND NOT EXISTS(
          SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')
        AND (n.nspname<>'public' OR p.oid::regprocedure::text NOT IN (
          'syntholo_account_name_readiness_v1()',
          'syntholo_business_os_cancelled(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_payment_failed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_payment_recovered(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_business_os_renewed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_cancelled(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_payment_failed(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_club_payment_recovered(uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone)',
          'syntholo_content_assets_readiness_v1()',
          'syntholo_content_readiness_v1()',
          'syntholo_establish_owner(uuid,uuid,text,text,text,timestamp with time zone)',
          'syntholo_expire_business_os(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_club(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_included_support(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_expire_invitation(uuid,uuid,text,uuid,timestamp with time zone)',
          'syntholo_fulfill_product(uuid,uuid,text,text,text,text,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
          'syntholo_lock_scoped_system_account(uuid)',
          'syntholo_mux_apply_event_v1(text,text,text,text,timestamp with time zone,text,text,text,bigint,text,text,text,text,text,boolean,text,text)',
          'syntholo_open_dispute(uuid,uuid,text,text,uuid,timestamp with time zone)',
          'syntholo_record_business_os_setup_purchase(uuid,uuid,text,text,timestamp with time zone,timestamp with time zone)',
          'syntholo_record_access_decision(uuid,uuid,text,boolean,text,uuid[],integer,text,timestamp with time zone)',
          'syntholo_redeem_invitation(uuid,uuid,text,bytea,text,text,timestamp with time zone)',
          'syntholo_refund_product(uuid,uuid,text,uuid,text,timestamp with time zone)',
          'syntholo_resolve_dispute(uuid,uuid,text,uuid,text,timestamp with time zone)',
          'syntholo_runtime_readiness()'
        )))
        OR (n.nspname='public' AND p.proname~'^syntholo_' AND EXISTS(
          SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'))
      )))
  THEN RAISE EXCEPTION 'SYNTHOLO_RUNTIME_CAPABILITY_INVALID' USING ERRCODE='42501'; END IF;
END;
$fn$;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_import_mux_asset_v1(p_environment_id text,p_provider_asset_id text) RETURNS public.content_media_assets LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE asset public.content_media_assets; actor uuid; correlation uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  actor:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL THEN RAISE EXCEPTION 'CONTENT_STAFF_CONTEXT_REQUIRED'; END IF;
  SELECT * INTO asset FROM public.content_media_assets a WHERE a.environment_id=p_environment_id AND a.provider_asset_id=p_provider_asset_id FOR UPDATE;
  IF asset.id IS NULL THEN RAISE EXCEPTION 'MUX_ASSET_NOT_RECONCILED'; END IF;
  IF asset.signed_policy_playback_id IS NULL THEN RAISE EXCEPTION 'SIGNED_PLAYBACK_REQUIRED'; END IF;
  IF asset.imported_at IS NULL THEN UPDATE public.content_media_assets SET imported_at=date_trunc('milliseconds',clock_timestamp()),imported_by_staff_id=actor,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=asset.id RETURNING * INTO asset; INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_media_imported','content_media_asset',asset.id::text,correlation,jsonb_build_object('environmentId',asset.environment_id,'providerAssetId',asset.provider_asset_id),date_trunc('milliseconds',clock_timestamp())); END IF;
  RETURN asset;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_import_mux_asset_v1(text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_import_mux_asset_v1(text,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_load_mux_reconcile_target_v1(p_media_asset_id uuid,p_requested_revision integer) RETURNS TABLE(outcome text,media_asset_id uuid,environment_id text,provider_asset_id text,requested_revision integer) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE asset public.content_media_assets%ROWTYPE;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_media_asset_id IS NULL OR p_requested_revision IS NULL OR p_requested_revision<0 THEN RAISE EXCEPTION 'MUX_RECONCILE_TARGET_INVALID'; END IF;
  SELECT * INTO asset FROM public.content_media_assets a WHERE a.id=p_media_asset_id;
  IF asset.id IS NULL OR asset.state='deleted' THEN RETURN QUERY SELECT 'terminal'::text,NULL::uuid,NULL::text,NULL::text,NULL::integer; RETURN; END IF;
  IF asset.readiness_revision<>p_requested_revision THEN RETURN QUERY SELECT 'state_changed'::text,NULL::uuid,NULL::text,NULL::text,NULL::integer; RETURN; END IF;
  RETURN QUERY SELECT 'current'::text,asset.id,asset.environment_id,asset.provider_asset_id,p_requested_revision;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_load_mux_reconcile_target_v1(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_load_mux_reconcile_target_v1(uuid,integer) TO syntholo_worker;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_apply_mux_reconciliation_v1(
  p_actor_id text,p_correlation_id uuid,p_media_asset_id uuid,p_expected_revision integer,
  p_environment_id text,p_provider_asset_id text,p_asset_state text,p_signed_policy_playback_id text,
  p_duration_milliseconds bigint,p_aspect_ratio text,p_tracks jsonb
) RETURNS TABLE(outcome text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE
  asset public.content_media_assets%ROWTYPE;
  track public.content_media_tracks%ROWTYPE;
  track_key text;
  item jsonb;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp());
  changed boolean:=false;
  item_changed boolean:=false;
  event_uuid uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_actor_id IS NULL OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' OR p_correlation_id IS NULL OR p_media_asset_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0
    OR p_environment_id IS NULL OR p_environment_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' OR p_provider_asset_id IS NULL OR p_provider_asset_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_asset_state IS NULL OR p_asset_state NOT IN ('waiting','preparing','ready','errored','deleted') OR (p_signed_policy_playback_id IS NOT NULL AND p_signed_policy_playback_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$')
    OR (p_duration_milliseconds IS NOT NULL AND p_duration_milliseconds NOT BETWEEN 1 AND 86400000) OR (p_aspect_ratio IS NOT NULL AND p_aspect_ratio !~ '^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$')
    OR p_tracks IS NULL OR jsonb_typeof(p_tracks)<>'array' OR jsonb_array_length(p_tracks)>100 THEN RAISE EXCEPTION 'MUX_RECONCILE_INPUT_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_tracks) e WHERE jsonb_typeof(e)<>'object' OR NOT (e?&ARRAY['providerTrackId','state','language','label','closedCaptions','source']::text[]) OR e-ARRAY['providerTrackId','state','language','label','closedCaptions','source']::text[]<>'{}'::jsonb
    OR e->>'providerTrackId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' OR e->>'state' NOT IN ('preparing','ready','errored','deleted')
    OR e->>'language' !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' OR btrim(e->>'label')='' OR octet_length(e->>'label') NOT BETWEEN 1 AND 100
    OR jsonb_typeof(e->'closedCaptions')<>'boolean' OR e->>'source' NOT IN ('human','mux_generated'))
    OR (SELECT count(*)<>count(DISTINCT e->>'providerTrackId') FROM jsonb_array_elements(p_tracks) e) THEN RAISE EXCEPTION 'MUX_RECONCILE_TRACKS_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:mux:asset:'||p_environment_id||':'||p_provider_asset_id,0));
  SELECT * INTO asset FROM public.content_media_assets a WHERE a.id=p_media_asset_id FOR UPDATE;
  IF asset.id IS NULL OR asset.environment_id<>p_environment_id OR asset.provider_asset_id<>p_provider_asset_id THEN RAISE EXCEPTION 'MUX_RECONCILE_OWNERSHIP_INVALID'; END IF;
  IF asset.readiness_revision<>p_expected_revision THEN RETURN QUERY SELECT 'state_changed'::text; RETURN; END IF;
  FOR track_key IN SELECT provider_track_id FROM public.content_media_tracks WHERE media_asset_id=asset.id UNION SELECT e->>'providerTrackId' FROM jsonb_array_elements(p_tracks) e ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('content:mux:track:'||p_environment_id||':'||p_provider_asset_id||':'||track_key,0));
  END LOOP;
  PERFORM 1 FROM public.content_media_tracks t WHERE t.media_asset_id=asset.id ORDER BY t.id FOR UPDATE;
  changed:=ROW(asset.state,asset.signed_policy_playback_id,asset.duration_milliseconds,asset.aspect_ratio,asset.safe_error_code) IS DISTINCT FROM ROW(p_asset_state,p_signed_policy_playback_id,p_duration_milliseconds,p_aspect_ratio,NULL::text);
  FOR item IN SELECT e FROM jsonb_array_elements(p_tracks) e ORDER BY e->>'providerTrackId' LOOP
    SELECT * INTO track FROM public.content_media_tracks t WHERE t.media_asset_id=asset.id AND t.provider_track_id=item->>'providerTrackId';
    IF track.id IS NULL THEN
      INSERT INTO public.content_media_tracks(media_asset_id,provider_track_id,kind,language,label,closed_captions,source,state,readiness_revision,created_at,updated_at)
      VALUES(asset.id,item->>'providerTrackId','captions',item->>'language',item->>'label',(item->>'closedCaptions')::boolean,item->>'source',item->>'state',1,now_at,now_at);
      changed:=true;
    ELSE
      item_changed:=ROW(track.state,track.language,track.label,track.closed_captions,track.source,track.safe_error_code) IS DISTINCT FROM ROW(item->>'state',item->>'language',item->>'label',(item->>'closedCaptions')::boolean,item->>'source',NULL::text);
      IF item_changed THEN UPDATE public.content_media_tracks SET state=item->>'state',language=item->>'language',label=item->>'label',closed_captions=(item->>'closedCaptions')::boolean,source=item->>'source',safe_error_code=NULL,readiness_revision=readiness_revision+1,updated_at=now_at WHERE id=track.id; changed:=true; END IF;
    END IF;
  END LOOP;
  FOR track IN SELECT * FROM public.content_media_tracks t WHERE t.media_asset_id=asset.id AND t.state<>'deleted' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_tracks) e WHERE e->>'providerTrackId'=t.provider_track_id) ORDER BY t.id LOOP
    UPDATE public.content_media_tracks SET state='deleted',safe_error_code='MUX_TRACK_MISSING',readiness_revision=readiness_revision+1,updated_at=now_at WHERE id=track.id;
    changed:=true;
  END LOOP;
  UPDATE public.content_media_assets SET state=p_asset_state,signed_policy_playback_id=p_signed_policy_playback_id,duration_milliseconds=p_duration_milliseconds,aspect_ratio=p_aspect_ratio,safe_error_code=NULL,readiness_revision=readiness_revision+CASE WHEN changed THEN 1 ELSE 0 END,last_reconciled_at=now_at,updated_at=now_at WHERE id=asset.id RETURNING * INTO asset;
  IF changed THEN
    event_uuid:=gen_random_uuid();
    INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at) VALUES(gen_random_uuid(),NULL,'system',p_actor_id,'content_media_reconciled','content_media_asset',asset.id::text,p_correlation_id,jsonb_build_object('state',asset.state,'readinessRevision',asset.readiness_revision),now_at);
    INSERT INTO public.outbox_events(event_id,account_id,type,aggregate_id,payload,schema_version,status,attempts,available_at,created_at,occurred_at,actor_type,actor_id,correlation_id,max_attempts,claim_generation) VALUES(event_uuid,NULL,'content.media_state_changed.v1',asset.id::text,jsonb_build_object('mediaAssetId',asset.id::text,'objectKind','asset','state',asset.state,'readinessRevision',asset.readiness_revision),1,'pending',0,now_at,now_at,now_at,'system',p_actor_id,p_correlation_id,10,0);
  END IF;
  RETURN QUERY SELECT 'applied'::text;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_apply_mux_reconciliation_v1(text,uuid,uuid,integer,text,text,text,text,bigint,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_apply_mux_reconciliation_v1(text,uuid,uuid,integer,text,text,text,text,bigint,text,jsonb) TO syntholo_worker;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_recompute_readiness_event_v1(p_event_id uuid,p_handler_name text) RETURNS TABLE(outcome text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE
  source public.outbox_events%ROWTYPE;
  head public.course_heads%ROWTYPE;
  course_key text;
  asset_key text;
  gate jsonb;
  gate_digest text;
  issues jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_worker');
  IF p_event_id IS NULL OR p_handler_name<>'content.readiness_recompute' THEN RAISE EXCEPTION 'CONTENT_READINESS_HANDLER_INVALID'; END IF;
  SELECT * INTO source FROM public.outbox_events o WHERE o.event_id=p_event_id;
  IF source.event_id IS NULL OR source.type NOT IN ('content.lesson_published.v1','content.course_published.v1','content.version_archived.v1','content.media_state_changed.v1','content.resource_state_changed.v1','content.readiness_approved.v1') THEN RAISE EXCEPTION 'CONTENT_READINESS_EVENT_INVALID'; END IF;
  IF source.type='content.media_state_changed.v1' AND (NOT (source.payload?&ARRAY['mediaAssetId','objectKind','state','readinessRevision']::text[]) OR source.payload-ARRAY['mediaAssetId','objectKind','state','readinessRevision']::text[]<>'{}'::jsonb OR source.payload->>'mediaAssetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR source.payload->>'objectKind' NOT IN ('asset','track') OR source.payload->>'state' NOT IN ('waiting','preparing','ready','errored','deleted') OR jsonb_typeof(source.payload->'readinessRevision')<>'number' OR source.payload->>'readinessRevision' !~ '^(0|[1-9][0-9]{0,9})$') THEN RAISE EXCEPTION 'CONTENT_READINESS_PAYLOAD_INVALID'; END IF;
  IF source.type='content.course_published.v1' AND (NOT (source.payload?&ARRAY['courseId','courseVersionId','manifestHash']::text[]) OR source.payload-ARRAY['courseId','courseVersionId','manifestHash']::text[]<>'{}'::jsonb OR source.payload->>'courseId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR source.payload->>'courseVersionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR source.payload->>'manifestHash' !~ '^[0-9a-f]{64}$') THEN RAISE EXCEPTION 'CONTENT_READINESS_PAYLOAD_INVALID'; END IF;
  FOR course_key IN SELECT h.course_id::text FROM public.course_heads h WHERE h.channel='production' ORDER BY h.course_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('content:course:'||course_key,0));
    SELECT * INTO head FROM public.course_heads h WHERE h.course_id=course_key::uuid AND h.channel='production' FOR UPDATE;
    IF head.course_id IS NULL THEN CONTINUE; END IF;
    FOR asset_key IN
      SELECT a.environment_id||':'||a.provider_asset_id FROM public.course_version_lessons cvl
      JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id
      JOIN public.content_media_assets a ON a.id=lv.media_asset_id
      WHERE cvl.course_version_id=head.current_course_version_id ORDER BY a.environment_id,a.provider_asset_id
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('content:mux:asset:'||asset_key,0));
    END LOOP;
    PERFORM 1 FROM public.content_media_assets a JOIN public.lesson_versions lv ON lv.media_asset_id=a.id JOIN public.course_version_lessons cvl ON cvl.lesson_version_id=lv.id WHERE cvl.course_version_id=head.current_course_version_id ORDER BY a.id FOR SHARE OF a;
    SELECT jsonb_build_object(
      'schemaVersion',1,'evaluatorVersion','content-readiness-v1','courseVersionId',head.current_course_version_id::text,'manifestHash',head.manifest_hash,
      'courseArchived',EXISTS(SELECT 1 FROM public.content_archives ar WHERE ar.target_kind='course' AND ar.target_version_id=head.current_course_version_id),
      'lessons',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'lessonId',cvl.lesson_id::text,'lessonSlug',l.slug,'stageSlug',s.slug,'lessonVersionId',cvl.lesson_version_id::text,'lessonOrder',cvl.lesson_order,'stageOrder',cvl.stage_order,'required',cvl.required,
        'lessonArchived',EXISTS(SELECT 1 FROM public.content_archives ar WHERE ar.target_kind='lesson' AND ar.target_version_id=cvl.lesson_version_id),
        'media',CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id::text,'state',a.state,'revision',a.readiness_revision,'signedPlaybackId',a.signed_policy_playback_id) END,
        'tracks',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id::text,'state',t.state,'revision',t.readiness_revision,'language',t.language,'closedCaptions',t.closed_captions) ORDER BY t.id) FROM public.content_media_tracks t WHERE t.media_asset_id=a.id),'[]'::jsonb),
        'resources',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.resource_id::text,'contentHash',r.content_hash,'deliveryReference',r.delivery_reference,'state',rh.state,'revision',rh.readiness_revision) ORDER BY r."order",r.resource_id) FROM public.lesson_version_resources r LEFT JOIN public.resource_delivery_health rh ON rh.delivery_reference=r.delivery_reference WHERE r.lesson_version_id=cvl.lesson_version_id),'[]'::jsonb)
      ) ORDER BY cvl.lesson_order,cvl.lesson_id) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id JOIN public.lessons l ON l.id=cvl.lesson_id JOIN public.stages s ON s.id=cvl.stage_id LEFT JOIN public.content_media_assets a ON a.id=lv.media_asset_id WHERE cvl.course_version_id=head.current_course_version_id),'[]'::jsonb)
    ) INTO gate;
    gate_digest:=encode(sha256(convert_to(gate::text,'UTF8')),'hex');
    SELECT COALESCE(jsonb_agg(found.issue ORDER BY found.code,found.target_id),'[]'::jsonb) INTO issues FROM (
      SELECT 'COURSE_REQUIRED_COUNT' code,head.current_course_version_id::text target_id,jsonb_build_object('code','COURSE_REQUIRED_COUNT','targetId',head.current_course_version_id::text) issue WHERE (SELECT count(*) FROM public.course_version_lessons cvl WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required)<>18
      UNION ALL SELECT 'COURSE_LAUNCH_MANIFEST',head.current_course_version_id::text,jsonb_build_object('code','COURSE_LAUNCH_MANIFEST','targetId',head.current_course_version_id::text) WHERE (SELECT count(*) FROM public.course_version_lessons cvl JOIN public.lessons l ON l.id=cvl.lesson_id JOIN public.stages s ON s.id=cvl.stage_id JOIN (VALUES
        (1,1,'diagnose','diagnose-1'),(1,2,'diagnose','diagnose-2'),(1,3,'diagnose','diagnose-3'),
        (2,4,'rules','rules-1'),(2,5,'rules','rules-2'),(2,6,'rules','rules-3'),
        (3,7,'growth','growth-1'),(3,8,'growth','growth-2'),(3,9,'growth','growth-3'),
        (4,10,'client','client-1'),(4,11,'client','client-2'),(4,12,'client','client-3'),
        (5,13,'management','management-1'),(5,14,'management','management-2'),(5,15,'management','management-3'),
        (6,16,'launch','launch-1'),(6,17,'launch','launch-2'),(6,18,'launch','launch-3')
      ) expected(stage_order,lesson_order,stage_slug,lesson_slug) ON expected.stage_order=cvl.stage_order AND expected.lesson_order=cvl.lesson_order AND expected.stage_slug=s.slug AND expected.lesson_slug=l.slug WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required)<>18
      UNION ALL SELECT 'COURSE_ARCHIVED',head.current_course_version_id::text,jsonb_build_object('code','COURSE_ARCHIVED','targetId',head.current_course_version_id::text) WHERE EXISTS(SELECT 1 FROM public.content_archives ar WHERE ar.target_kind='course' AND ar.target_version_id=head.current_course_version_id)
      UNION ALL SELECT 'LESSON_ARCHIVED',cvl.lesson_version_id::text,jsonb_build_object('code','LESSON_ARCHIVED','targetId',cvl.lesson_version_id::text) FROM public.course_version_lessons cvl WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND EXISTS(SELECT 1 FROM public.content_archives ar WHERE ar.target_kind='lesson' AND ar.target_version_id=cvl.lesson_version_id)
      UNION ALL SELECT 'MEDIA_MISSING',lv.id::text,jsonb_build_object('code','MEDIA_MISSING','targetId',lv.id::text) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id LEFT JOIN public.content_media_assets a ON a.id=lv.media_asset_id WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND a.id IS NULL
      UNION ALL SELECT 'MEDIA_NOT_READY',a.id::text,jsonb_build_object('code','MEDIA_NOT_READY','targetId',a.id::text) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id JOIN public.content_media_assets a ON a.id=lv.media_asset_id WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND a.state<>'ready'
      UNION ALL SELECT 'SIGNED_PLAYBACK_MISSING',a.id::text,jsonb_build_object('code','SIGNED_PLAYBACK_MISSING','targetId',a.id::text) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id JOIN public.content_media_assets a ON a.id=lv.media_asset_id WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND a.signed_policy_playback_id IS NULL
      UNION ALL SELECT 'MEDIA_DURATION_MISMATCH',a.id::text,jsonb_build_object('code','MEDIA_DURATION_MISMATCH','targetId',a.id::text) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id JOIN public.content_media_assets a ON a.id=lv.media_asset_id WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND a.duration_milliseconds IS DISTINCT FROM lv.duration_seconds::bigint*1000
      UNION ALL SELECT 'CAPTIONS_NOT_READY',a.id::text,jsonb_build_object('code','CAPTIONS_NOT_READY','targetId',a.id::text) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id JOIN public.content_media_assets a ON a.id=lv.media_asset_id WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND NOT EXISTS(SELECT 1 FROM public.content_media_tracks t WHERE t.media_asset_id=a.id AND t.state='ready' AND t.closed_captions AND (lower(t.language)='en' OR lower(t.language) LIKE 'en-%'))
      UNION ALL SELECT 'TRANSCRIPT_INCOMPLETE',lv.id::text,jsonb_build_object('code','TRANSCRIPT_INCOMPLETE','targetId',lv.id::text) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND CASE WHEN jsonb_typeof(lv.transcript->'blocks')='array' THEN jsonb_array_length(lv.transcript->'blocks')=0 ELSE true END
      UNION ALL SELECT 'ACTION_BLOCK_MISSING',lv.id::text,jsonb_build_object('code','ACTION_BLOCK_MISSING','targetId',lv.id::text) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(lv.blocks) b WHERE b->>'type'='action')
      UNION ALL SELECT 'RESOURCE_MISSING',lv.id::text,jsonb_build_object('code','RESOURCE_MISSING','targetId',lv.id::text) FROM public.course_version_lessons cvl JOIN public.lesson_versions lv ON lv.id=cvl.lesson_version_id WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND NOT EXISTS(SELECT 1 FROM public.lesson_version_resources r WHERE r.lesson_version_id=lv.id)
      UNION ALL SELECT 'RESOURCE_NOT_READY',r.resource_id::text,jsonb_build_object('code','RESOURCE_NOT_READY','targetId',r.resource_id::text) FROM public.course_version_lessons cvl JOIN public.lesson_version_resources r ON r.lesson_version_id=cvl.lesson_version_id LEFT JOIN public.resource_delivery_health rh ON rh.delivery_reference=r.delivery_reference WHERE cvl.course_version_id=head.current_course_version_id AND cvl.required AND (rh.delivery_reference IS NULL OR rh.state<>'ready')
    ) found;
    INSERT INTO public.content_readiness_evaluations(course_version_id,gate_hash,issues,passed,evaluator_version,evaluated_at)
    VALUES(head.current_course_version_id,gate_digest,issues,jsonb_array_length(issues)=0,'content-readiness-v1',date_trunc('milliseconds',clock_timestamp())) ON CONFLICT(course_version_id,gate_hash) DO NOTHING;
  END LOOP;
  RETURN QUERY SELECT 'evaluated'::text;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_recompute_readiness_event_v1(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_recompute_readiness_event_v1(uuid,text) TO syntholo_worker;
--> statement-breakpoint
REVOKE ALL ON public.content_media_assets,public.content_media_tracks FROM PUBLIC,syntholo_member_api,syntholo_system_api,syntholo_worker;
--> statement-breakpoint
GRANT SELECT ON public.content_media_assets,public.content_media_tracks TO syntholo_staff_api;
--> statement-breakpoint
GRANT ALL ON public.content_media_assets,public.content_media_tracks TO syntholo_migrator;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.syntholo_runtime_readiness()
RETURNS TABLE(schema_version text,migration_count integer,migration_hashes text[],required_objects text[],runtime_role text,capability text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  WITH RECURSIVE readiness_owner AS (
    SELECT owner.oid,owner.rolname
    FROM pg_proc procedure JOIN pg_roles owner ON owner.oid=procedure.proowner
    WHERE procedure.oid='public.syntholo_runtime_readiness()'::regprocedure
  ), memberships AS (
    SELECT membership.roleid,ARRAY[membership.roleid]::oid[] path
    FROM pg_auth_members membership JOIN pg_roles login ON login.oid=membership.member
    WHERE login.rolname=session_user
    UNION ALL
    SELECT membership.roleid,parent.path||membership.roleid
    FROM pg_auth_members membership JOIN memberships parent ON parent.roleid=membership.member
    WHERE NOT membership.roleid=ANY(parent.path)
  ), login_state AS (
    SELECT login.oid,login.rolname,login.rolsuper,login.rolcreatedb,
      login.rolcreaterole,login.rolreplication,login.rolbypassrls
    FROM pg_roles login WHERE login.rolname=session_user
  ), runtime AS (
    SELECT session_user role_name,CASE
      WHEN session_user=(SELECT rolname FROM readiness_owner) THEN 'syntholo_migrator'
      WHEN (SELECT count(DISTINCT roleid) FROM memberships)=1
        AND EXISTS(SELECT 1 FROM memberships WHERE roleid=(SELECT oid FROM readiness_owner))
        THEN 'syntholo_migrator'
      WHEN NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM login_state)
        AND (SELECT count(DISTINCT roleid) FROM memberships)=1
        AND pg_has_role(session_user,'syntholo_member_api','MEMBER') THEN 'syntholo_member_api'
      WHEN NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM login_state)
        AND (SELECT count(DISTINCT roleid) FROM memberships)=1
        AND pg_has_role(session_user,'syntholo_staff_api','MEMBER') THEN 'syntholo_staff_api'
      WHEN NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM login_state)
        AND (SELECT count(DISTINCT roleid) FROM memberships)=1
        AND pg_has_role(session_user,'syntholo_worker','MEMBER') THEN 'syntholo_worker'
      WHEN NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM login_state)
        AND (SELECT count(DISTINCT roleid) FROM memberships)=1
        AND pg_has_role(session_user,'syntholo_system_api','MEMBER') THEN 'syntholo_system_api'
      ELSE NULL END capability_name
  ), expected(created_at,hash,ordinal) AS (VALUES
    (1786618800000::bigint,'bf3b66561107047f8c317d81bb561e9a29dc6207a14469a3ce588ec1f8ddc60c'::text,1),
    (1786626000000::bigint,'6508044b65dcce22b5d9a25b954a40768b813d84f943247e59f6c6391cec60a4'::text,2),
    (1786633200000::bigint,'5b1e18eeeb392048ebcd7436622c60702694758b84edc209afb91ba861b8d9da'::text,3),
    (1786640400000::bigint,'717c39300253771cbd09070c2b75297c0bfd788290c522877bbbf7293c4a7ea1'::text,4),
    (1786647600000::bigint,'b61002f28e9970c63ea24a291ebcca8711bdd1f1a178b9ce09910243cc6683b5'::text,5),
    (1786654800000::bigint,'6b465ae711125f441115f83dfbfe9bf63e92a74edd57190e357c10268adeafb5'::text,6),
    (1786662000000::bigint,'cc614367c67c41e46a22d951a5d413ce272e356b0fcd20d8ab0ab992d6727002'::text,7)
  ), required(name,object_oid) AS (VALUES
    ('public.access_decision_audit',to_regclass('public.access_decision_audit')),
    ('public.account_hold_sources',to_regclass('public.account_hold_sources')),
    ('public.account_holds',to_regclass('public.account_holds')),
    ('public.accounts',to_regclass('public.accounts')),
    ('public.administrative_grant_restorations',to_regclass('public.administrative_grant_restorations')),
    ('public.audit_events',to_regclass('public.audit_events')),
    ('public.business_os_setup_receipts',to_regclass('public.business_os_setup_receipts')),
    ('public.business_os_subscription_cancellations',to_regclass('public.business_os_subscription_cancellations')),
    ('public.club_subscription_cancellations',to_regclass('public.club_subscription_cancellations')),
    ('public.commerce_fulfillment_receipts',to_regclass('public.commerce_fulfillment_receipts')),
    ('public.commerce_reconciliations',to_regclass('public.commerce_reconciliations')),
    ('public.entitlement_commands',to_regclass('public.entitlement_commands')),
    ('public.entitlement_grants',to_regclass('public.entitlement_grants')),
    ('public.entitlement_sources',to_regclass('public.entitlement_sources')),
    ('public.event_handler_receipts',to_regclass('public.event_handler_receipts')),
    ('public.job_attempts',to_regclass('public.job_attempts')),
    ('public.jobs',to_regclass('public.jobs')),
    ('public.member_identities',to_regclass('public.member_identities')),
    ('public.memberships',to_regclass('public.memberships')),
    ('public.outbox_events',to_regclass('public.outbox_events')),
    ('public.provider_event_receipts',to_regclass('public.provider_event_receipts')),
    ('public.seat_invitation_token_generations',to_regclass('public.seat_invitation_token_generations')),
    ('public.seat_invitations',to_regclass('public.seat_invitations')),
    ('public.seat_reservations',to_regclass('public.seat_reservations')),
    ('public.staff_identities',to_regclass('public.staff_identities')),
    ('public.staff_login_attempts',to_regclass('public.staff_login_attempts')),
    ('public.staff_sessions',to_regclass('public.staff_sessions'))
  ), actual_journal AS (
    SELECT actual.created_at,actual.hash,row_number() OVER(ORDER BY actual.created_at,actual.id) ordinal
    FROM drizzle.__drizzle_migrations actual
  ), journal AS (
    SELECT (SELECT count(*) FROM actual_journal WHERE ordinal<=7)=7
      AND NOT EXISTS(
        SELECT 1 FROM actual_journal actual FULL JOIN expected USING(ordinal)
        WHERE coalesce(actual.ordinal,expected.ordinal)<=7
          AND (actual.created_at IS DISTINCT FROM expected.created_at OR actual.hash IS DISTINCT FROM expected.hash))
      AND NOT EXISTS(SELECT 1 FROM actual_journal WHERE ordinal>7 AND (created_at IS NULL OR created_at<=1786662000000)) ready
  )
  SELECT '0007_runtime_contract'::text,7::integer,
    (SELECT array_agg(hash ORDER BY ordinal) FROM expected),
    (SELECT array_agg(required.name ORDER BY required.name) FROM required JOIN pg_class ON pg_class.oid=required.object_oid WHERE pg_class.relowner=(SELECT oid FROM readiness_owner)),
    runtime.role_name::text,runtime.capability_name::text
  FROM runtime CROSS JOIN journal
  WHERE runtime.capability_name IS NOT NULL AND journal.ready
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_runtime_readiness() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_runtime_readiness() TO syntholo_migrator,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_assets_readiness_v1() RETURNS TABLE(contract_version text,migration_created_at bigint,migration_hash text,asset_table_ready boolean,track_table_ready boolean,binding_ready boolean,receipt_constraint_ready boolean,table_acl_ready boolean,function_acl_ready boolean,public_execute_denied boolean,empty_catalog boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
  SELECT '0010_content_assets.v1',1786683600000::bigint,j.hash,
    to_regclass('public.content_media_assets') IS NOT NULL,
    to_regclass('public.content_media_tracks') IS NOT NULL,
    (SELECT count(*)=2 FROM pg_constraint WHERE conname IN ('lesson_drafts_media_asset_fk','lesson_versions_media_asset_fk') AND contype='f' AND convalidated),
    EXISTS(SELECT 1 FROM pg_constraint WHERE conname='provider_event_receipts_mux_safe_payload_check' AND contype='c' AND convalidated),
    has_table_privilege('syntholo_staff_api','public.content_media_assets','SELECT') AND has_table_privilege('syntholo_staff_api','public.content_media_tracks','SELECT') AND NOT has_table_privilege('syntholo_member_api','public.content_media_assets','SELECT') AND NOT has_table_privilege('syntholo_system_api','public.content_media_assets','SELECT'),
    has_function_privilege('syntholo_system_api','public.syntholo_mux_apply_event_v1(text,text,text,text,timestamptz,text,text,text,bigint,text,text,text,text,text,boolean,text,text)','EXECUTE') AND NOT has_function_privilege('syntholo_staff_api','public.syntholo_mux_apply_event_v1(text,text,text,text,timestamptz,text,text,text,bigint,text,text,text,text,text,boolean,text,text)','EXECUTE') AND has_function_privilege('syntholo_staff_api','public.syntholo_content_import_mux_asset_v1(text,text)','EXECUTE') AND has_function_privilege('syntholo_worker','public.syntholo_content_load_mux_reconcile_target_v1(uuid,integer)','EXECUTE') AND has_function_privilege('syntholo_worker','public.syntholo_content_apply_mux_reconciliation_v1(text,uuid,uuid,integer,text,text,text,text,bigint,text,jsonb)','EXECUTE') AND has_function_privilege('syntholo_worker','public.syntholo_content_recompute_readiness_event_v1(uuid,text)','EXECUTE'),
    NOT EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE n.nspname='public' AND p.oid::regprocedure::text IN (
        'syntholo_mux_apply_event_v1(text,text,text,text,timestamp with time zone,text,text,text,bigint,text,text,text,text,text,boolean,text,text)',
        'syntholo_content_import_mux_asset_v1(text,text)',
        'syntholo_content_load_mux_reconcile_target_v1(uuid,integer)',
        'syntholo_content_apply_mux_reconciliation_v1(text,uuid,uuid,integer,text,text,text,text,bigint,text,jsonb)',
        'syntholo_content_recompute_readiness_event_v1(uuid,text)')
        AND acl.grantee=0 AND acl.privilege_type='EXECUTE'),
    NOT EXISTS(SELECT 1 FROM public.content_media_assets UNION ALL SELECT 1 FROM public.content_media_tracks)
  FROM drizzle.__drizzle_migrations j WHERE j.created_at=1786683600000
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_assets_readiness_v1() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_assets_readiness_v1() TO syntholo_migrator,syntholo_member_api,syntholo_staff_api,syntholo_worker,syntholo_system_api;
