-- Real Mux direct-upload attachment for lesson video.
--
-- syntholo_content_upsert_lesson_draft_v1 (0015_content_authoring.sql) still seeds a
-- SYNTHETIC content_media_assets row for brand-new lessons so the local/dev authoring
-- flow keeps working without touching Mux. This migration adds a second, real path:
-- once staff has driven a browser upload through Mux's direct-upload API and Mux has
-- created a real asset, syntholo_content_attach_lesson_media_v1 registers that real
-- asset (in 'waiting' state — nothing is known about it yet), swaps the lesson draft's
-- synthetic video block for one pointing at the real asset, and enqueues the SAME
-- content.mux_reconcile.v1 job that syntholo_mux_apply_event_v1 enqueues on conflict.
-- The worker's existing reconcile handler (apps/worker/src/handlers/content/mux.ts,
-- already wired and already working locally without needing a reachable webhook) then
-- polls Mux directly and carries the row from 'waiting' through to 'ready'.
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_attach_lesson_media_v1(
  p_lesson_id uuid, p_expected_revision integer, p_environment_id text, p_provider_asset_id text,
  p_idempotency_key text, p_request_hash text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; claimed boolean;
  draft public.lesson_drafts; asset public.content_media_assets; new_blocks jsonb; response_payload jsonb;
  old_resource public.content_resource_drafts; new_resource_id uuid; resource_map jsonb:='{}'::jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL
    OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$'
    OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_environment_id IS NULL OR p_environment_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_provider_asset_id IS NULL OR p_provider_asset_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    OR p_expected_revision IS NULL OR p_expected_revision<1
  THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'POST','/v1/staff/content/lessons/:lessonId/media',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING RETURNING * INTO receipt;
  claimed:=FOUND;
  IF NOT claimed THEN
    SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='POST' AND route_template='/v1/staff/content/lessons/:lessonId/media' AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
    IF receipt.status='completed' THEN RETURN receipt.response; END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:lesson:'||p_lesson_id::text,0));
  SELECT * INTO draft FROM public.lesson_drafts WHERE lesson_id=p_lesson_id FOR UPDATE;
  IF draft.lesson_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  IF draft.revision<>p_expected_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:mux:asset:'||p_environment_id||':'||p_provider_asset_id,0));
  INSERT INTO public.content_media_assets(provider,environment_id,provider_asset_id,state,readiness_revision,created_at,updated_at)
  VALUES('mux',p_environment_id,p_provider_asset_id,'waiting',0,now_at,now_at)
  ON CONFLICT(environment_id,provider_asset_id) DO NOTHING;
  SELECT * INTO asset FROM public.content_media_assets a WHERE a.environment_id=p_environment_id AND a.provider_asset_id=p_provider_asset_id FOR UPDATE;
  -- Bumping lesson_drafts.revision orphans any content_resource_drafts row still
  -- tied to the OLD revision (syntholo_content_lesson_issues_v1's RESOURCE_REQUIRED /
  -- resource_refs_valid checks join on lesson_draft_revision=d.revision). Carry every
  -- still-active resource forward to the new revision, under a fresh id, and remember
  -- the old->new id mapping so the resource_list block(s) below can be rewritten to
  -- point at the carried-forward rows — mirroring how syntholo_content_upsert_lesson_
  -- draft_v1 always (re)creates a fresh resource row per revision.
  FOR old_resource IN
    SELECT * FROM public.content_resource_drafts
    WHERE lesson_id=p_lesson_id AND lesson_draft_revision=draft.revision AND archived_at IS NULL
    ORDER BY id
  LOOP
    INSERT INTO public.content_resource_drafts(lesson_id,lesson_draft_revision,revision,label,accessible_label,delivery,delivery_reference,mime,byte_size,content_hash)
      VALUES(old_resource.lesson_id,draft.revision+1,old_resource.revision,old_resource.label,old_resource.accessible_label,old_resource.delivery,old_resource.delivery_reference,old_resource.mime,old_resource.byte_size,old_resource.content_hash)
      RETURNING id INTO new_resource_id;
    resource_map:=resource_map || jsonb_build_object(old_resource.id::text,new_resource_id::text);
  END LOOP;
  new_blocks:=(SELECT coalesce(jsonb_agg(
      CASE WHEN b->>'type'='resource_list' THEN jsonb_set(b,'{resourceIds}',(
        SELECT coalesce(jsonb_agg(coalesce(resource_map->>rid,rid)),'[]'::jsonb)
        FROM jsonb_array_elements_text(b->'resourceIds') rid
      )) ELSE b END
    ),'[]'::jsonb) FROM jsonb_array_elements(draft.blocks) b WHERE b->>'type'<>'video')
    || jsonb_build_array(jsonb_build_object('type','video','blockId','real-video','mediaAssetId',asset.id));
  IF NOT public.syntholo_content_blocks_valid_v1(new_blocks,draft.transcript,asset.id) THEN RAISE EXCEPTION 'CONTENT_BLOCKS_INVALID'; END IF;
  UPDATE public.lesson_drafts SET revision=revision+1,blocks=new_blocks,media_asset_id=asset.id,placeholder_detected=false,updated_by_staff_id=actor,updated_at=now_at WHERE lesson_id=p_lesson_id;
  INSERT INTO public.jobs(account_id,source_actor_type,source_actor_id,correlation_id,queue,type,idempotency_key,payload,status,priority,attempts,max_attempts,run_at,claim_generation,created_at,updated_at)
  VALUES(NULL,'staff',actor::text,correlation,'content','content.mux_reconcile.v1','content-mux-reconcile:'||asset.id::text||':'||asset.readiness_revision::text,jsonb_build_object('mediaAssetId',asset.id::text,'requestedRevision',asset.readiness_revision),'queued',0,0,5,now_at,0,now_at,now_at)
  ON CONFLICT(idempotency_key) DO NOTHING;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_lesson_media_attached','lesson',p_lesson_id::text,correlation,jsonb_build_object('lessonId',p_lesson_id::text,'mediaAssetId',asset.id::text,'environmentId',p_environment_id,'providerAssetId',p_provider_asset_id),now_at);
  response_payload:=jsonb_build_object('lessonId',p_lesson_id,'revision',draft.revision+1,'mediaAssetId',asset.id,'mediaState',asset.state);
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_attach_lesson_media_v1(uuid,integer,text,text,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.syntholo_content_attach_lesson_media_v1(uuid,integer,text,text,text,text) TO syntholo_staff_api;
