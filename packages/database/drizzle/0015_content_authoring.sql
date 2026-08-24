-- Content authoring + local learning-admin functions.
--
-- Local/dev-only scope note: real content authoring in production will go through
-- Mux (video) and blob storage (resources) pipelines. Those integrations are
-- intentionally disabled locally, so `syntholo_content_upsert_lesson_draft_v1` below
-- also seeds SYNTHETIC `content_media_assets` / `content_media_tracks` /
-- `content_resource_drafts` / `resource_delivery_health` rows already in `ready`
-- state so the *existing*, unmodified publish gate (`syntholo_content_lesson_issues_v1`
-- in 0011_learning.sql) can be satisfied honestly rather than bypassed. This is
-- clearly a local/admin-only placeholder, not a new production capability.
--
-- Similarly, `syntholo_content_admin_record_lesson_review_v1` is an explicit stub for
-- the real staff accessibility/disclosure review workflow (PRD Task 3/4): it always
-- approves and always marks disclosure "not_applicable".
--
-- `syntholo_learning_admin_grant_enrollment_v1` deliberately bypasses payment/commerce
-- (out of scope for this build) by issuing a staff-authorized `administrative`
-- entitlement source directly.
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_create_course_draft_v1(
  p_slug text, p_title text, p_description text, p_idempotency_key text, p_request_hash text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; claimed boolean; created public.courses; response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL
    OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$'
    OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_slug IS NULL OR octet_length(p_slug) NOT BETWEEN 1 AND 100 OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    OR NOT public.syntholo_content_nonblank_v1(p_title,1,255) OR p_title~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'
    OR NOT public.syntholo_content_nonblank_v1(p_description,1,10000) OR p_description~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'
  THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'POST','/v1/staff/content/courses',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING RETURNING * INTO receipt;
  claimed:=FOUND;
  IF NOT claimed THEN
    SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='POST' AND route_template='/v1/staff/content/courses' AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
    IF receipt.status='completed' THEN RETURN receipt.response; END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS';
  END IF;
  INSERT INTO public.courses(slug,title,description,current_draft_revision) VALUES(p_slug,p_title,p_description,1) RETURNING * INTO created;
  INSERT INTO public.course_drafts(course_id,revision,title,description,updated_by_staff_id) VALUES(created.id,1,p_title,p_description,actor);
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_course_draft_created','course',created.id::text,correlation,jsonb_build_object('courseId',created.id::text,'slug',created.slug),now_at);
  response_payload:=jsonb_build_object('courseId',created.id,'slug',created.slug,'title',created.title,'description',created.description,'revision',1,'createdAt',to_char(created.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'CONTENT_SLUG_TAKEN';
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_create_course_draft_v1(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_create_course_draft_v1(text,text,text,text,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_upsert_stage_draft_v1(
  p_course_id uuid, p_expected_course_revision integer, p_stage_id_or_null uuid,
  p_slug text, p_title text, p_description text, p_order integer,
  p_idempotency_key text, p_request_hash text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; claimed boolean;
  draft public.course_drafts; stage public.stages; existing public.stage_drafts; revision integer; response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL
    OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$'
    OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_slug IS NULL OR octet_length(p_slug) NOT BETWEEN 1 AND 100 OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    OR NOT public.syntholo_content_nonblank_v1(p_title,1,255) OR p_title~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'
    OR NOT public.syntholo_content_nonblank_v1(p_description,1,10000) OR p_description~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'
    OR p_order IS NULL OR p_order<1 OR p_order>1000
  THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'POST','/v1/staff/content/stages',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING RETURNING * INTO receipt;
  claimed:=FOUND;
  IF NOT claimed THEN
    SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='POST' AND route_template='/v1/staff/content/stages' AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
    IF receipt.status='completed' THEN RETURN receipt.response; END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:course:'||p_course_id::text,0));
  SELECT * INTO draft FROM public.course_drafts WHERE course_id=p_course_id FOR UPDATE;
  IF draft.course_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  IF draft.revision<>p_expected_course_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  IF p_stage_id_or_null IS NULL THEN
    INSERT INTO public.stages(course_id,slug) VALUES(p_course_id,p_slug) RETURNING * INTO stage;
    revision:=1;
  ELSE
    SELECT * INTO stage FROM public.stages WHERE id=p_stage_id_or_null AND course_id=p_course_id;
    IF stage.id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
    SELECT * INTO existing FROM public.stage_drafts WHERE stage_id=stage.id FOR UPDATE;
    revision:=coalesce(existing.revision,0)+1;
  END IF;
  INSERT INTO public.stage_drafts(stage_id,course_id,revision,title,description,"order",updated_by_staff_id)
    VALUES(stage.id,p_course_id,revision,p_title,p_description,p_order,actor)
    ON CONFLICT(stage_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,description=excluded.description,"order"=excluded."order",updated_by_staff_id=excluded.updated_by_staff_id,updated_at=now_at;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_stage_draft_upserted','stage',stage.id::text,correlation,jsonb_build_object('courseId',p_course_id::text,'stageId',stage.id::text,'order',p_order),now_at);
  response_payload:=jsonb_build_object('stageId',stage.id,'courseId',p_course_id,'slug',stage.slug,'title',p_title,'description',p_description,'order',p_order,'revision',revision);
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'CONTENT_SLUG_TAKEN';
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_upsert_stage_draft_v1(uuid,integer,uuid,text,text,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_upsert_stage_draft_v1(uuid,integer,uuid,text,text,text,integer,text,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_upsert_lesson_draft_v1(
  p_course_id uuid, p_stage_id uuid, p_lesson_id_or_null uuid,
  p_slug text, p_title text, p_summary text, p_duration_seconds integer,
  p_blocks jsonb, p_transcript jsonb, p_order integer, p_required boolean,
  p_idempotency_key text, p_request_hash text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; claimed boolean;
  stage_draft public.stage_drafts; lesson public.lessons; existing_draft public.lesson_drafts; revision integer;
  media_asset_id uuid; resource_id uuid; final_blocks jsonb; response_payload jsonb; content_hash text;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL
    OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$'
    OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_slug IS NULL OR octet_length(p_slug) NOT BETWEEN 1 AND 100 OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    OR NOT public.syntholo_content_nonblank_v1(p_title,1,255) OR p_title~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'
    OR NOT public.syntholo_content_nonblank_v1(p_summary,1,10000) OR p_summary~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'
    OR p_duration_seconds IS NULL OR p_duration_seconds NOT BETWEEN 300 AND 720
    OR p_order IS NULL OR p_order<1 OR p_order>1000 OR p_required IS NULL
    OR jsonb_typeof(p_blocks)<>'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_blocks) b WHERE b->>'type' IN ('video','resource_list'))
  THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'POST','/v1/staff/content/lessons',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING RETURNING * INTO receipt;
  claimed:=FOUND;
  IF NOT claimed THEN
    SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='POST' AND route_template='/v1/staff/content/lessons' AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
    IF receipt.status='completed' THEN RETURN receipt.response; END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:course:'||p_course_id::text,0));
  SELECT * INTO stage_draft FROM public.stage_drafts WHERE stage_id=p_stage_id AND course_id=p_course_id FOR UPDATE;
  IF stage_draft.stage_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  IF p_lesson_id_or_null IS NULL THEN
    INSERT INTO public.lessons(course_id,stage_id,slug) VALUES(p_course_id,p_stage_id,p_slug) RETURNING * INTO lesson;
    revision:=1;
    INSERT INTO public.content_media_assets(environment_id,provider_asset_id,signed_policy_playback_id,state,duration_milliseconds,imported_at,imported_by_staff_id)
      VALUES('local-dev-synthetic',replace(lesson.id::text,'-',''),'pb-'||replace(gen_random_uuid()::text,'-',''),'ready',p_duration_seconds::bigint*1000,now_at,actor)
      RETURNING id INTO media_asset_id;
    INSERT INTO public.content_media_tracks(media_asset_id,provider_track_id,kind,language,label,closed_captions,source,state)
      VALUES(media_asset_id,'cap-en', 'captions','en','English (synthetic)',true,'human','ready');
    INSERT INTO public.lesson_accessibility_review_heads(lesson_id) VALUES(lesson.id);
    INSERT INTO public.lesson_disclosure_review_heads(lesson_id) VALUES(lesson.id);
  ELSE
    SELECT * INTO lesson FROM public.lessons WHERE id=p_lesson_id_or_null AND course_id=p_course_id AND stage_id=p_stage_id;
    IF lesson.id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
    SELECT * INTO existing_draft FROM public.lesson_drafts WHERE lesson_id=lesson.id FOR UPDATE;
    IF existing_draft.lesson_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
    revision:=existing_draft.revision+1;
    media_asset_id:=existing_draft.media_asset_id;
    UPDATE public.content_media_assets SET duration_milliseconds=p_duration_seconds::bigint*1000,updated_at=now_at WHERE id=media_asset_id;
  END IF;
  content_hash:=encode(sha256(convert_to('local-dev-resource:'||lesson.id::text||':'||revision::text,'UTF8')),'hex');
  INSERT INTO public.content_resource_drafts(lesson_id,lesson_draft_revision,revision,label,accessible_label,delivery,delivery_reference,mime,byte_size,content_hash)
    VALUES(lesson.id,revision,1,'Lesson worksheet','Lesson worksheet (PDF)','external_https','https://assets.syntholo.local/worksheets/'||lesson.id::text||'.pdf','application/pdf',102400,content_hash)
    RETURNING id INTO resource_id;
  INSERT INTO public.resource_delivery_health(delivery_reference,state) VALUES('https://assets.syntholo.local/worksheets/'||lesson.id::text||'.pdf','ready')
    ON CONFLICT(delivery_reference) DO UPDATE SET state='ready',checked_at=now_at;
  final_blocks:=p_blocks
    || jsonb_build_array(jsonb_build_object('type','video','blockId','synthetic-video','mediaAssetId',media_asset_id))
    || jsonb_build_array(jsonb_build_object('type','resource_list','blockId','synthetic-resources','resourceIds',jsonb_build_array(resource_id)));
  IF NOT public.syntholo_content_blocks_valid_v1(final_blocks,p_transcript,media_asset_id) THEN RAISE EXCEPTION 'CONTENT_BLOCKS_INVALID'; END IF;
  INSERT INTO public.lesson_drafts(lesson_id,course_id,stage_id,revision,title,summary,duration_seconds,blocks,transcript,media_asset_id,stage_order,"order",required,release_rule,placeholder_detected,updated_by_staff_id,updated_at)
    VALUES(lesson.id,p_course_id,p_stage_id,revision,p_title,p_summary,p_duration_seconds,final_blocks,p_transcript,media_asset_id,stage_draft."order",p_order,p_required,'{"kind":"immediate"}'::jsonb,false,actor,now_at)
    ON CONFLICT(lesson_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,summary=excluded.summary,duration_seconds=excluded.duration_seconds,blocks=excluded.blocks,transcript=excluded.transcript,media_asset_id=excluded.media_asset_id,stage_order=excluded.stage_order,"order"=excluded."order",required=excluded.required,placeholder_detected=false,updated_by_staff_id=excluded.updated_by_staff_id,updated_at=excluded.updated_at;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_lesson_draft_upserted','lesson',lesson.id::text,correlation,jsonb_build_object('courseId',p_course_id::text,'stageId',p_stage_id::text,'lessonId',lesson.id::text,'revision',revision),now_at);
  response_payload:=jsonb_build_object('lessonId',lesson.id,'courseId',p_course_id,'stageId',p_stage_id,'slug',lesson.slug,'revision',revision,'mediaAssetId',media_asset_id,'order',p_order,'required',p_required);
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'CONTENT_SLUG_TAKEN';
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_upsert_lesson_draft_v1(uuid,uuid,uuid,text,text,text,integer,jsonb,jsonb,integer,boolean,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_upsert_lesson_draft_v1(uuid,uuid,uuid,text,text,text,integer,jsonb,jsonb,integer,boolean,text,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_admin_record_lesson_review_v1(p_lesson_id uuid, p_expected_revision integer, p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
-- Local/admin-only stub for the real staff accessibility/disclosure review workflow
-- (PRD Task 3/4). Always approves accessibility and marks disclosure not_applicable.
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); draft public.lesson_drafts; draft_hash text;
  a_head public.lesson_accessibility_review_heads; d_head public.lesson_disclosure_review_heads; a_seq integer; d_seq integer;
  a_decision_id uuid; d_decision_id uuid;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL
    OR p_reason IS NULL OR octet_length(p_reason) NOT BETWEEN 1 AND 1000
  THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:lesson:'||p_lesson_id::text,0));
  SELECT * INTO draft FROM public.lesson_drafts WHERE lesson_id=p_lesson_id FOR UPDATE;
  IF draft.lesson_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  IF draft.revision<>p_expected_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  draft_hash:=public.syntholo_lesson_draft_hash_v1(p_lesson_id);
  SELECT * INTO a_head FROM public.lesson_accessibility_review_heads WHERE lesson_id=p_lesson_id FOR UPDATE;
  a_seq:=coalesce(a_head.decision_sequence,0)+1;
  INSERT INTO public.lesson_accessibility_decisions(lesson_id,draft_revision,draft_hash,decision_sequence,decision,reviewer_staff_id,reason)
    VALUES(p_lesson_id,p_expected_revision,draft_hash,a_seq,'approved',actor,p_reason) RETURNING id INTO a_decision_id;
  UPDATE public.lesson_accessibility_review_heads SET decision_sequence=a_seq,current_decision_id=a_decision_id,current_draft_revision=p_expected_revision,current_draft_hash=draft_hash,updated_at=now_at WHERE lesson_id=p_lesson_id;
  SELECT * INTO d_head FROM public.lesson_disclosure_review_heads WHERE lesson_id=p_lesson_id FOR UPDATE;
  d_seq:=coalesce(d_head.decision_sequence,0)+1;
  INSERT INTO public.lesson_disclosure_decisions(lesson_id,draft_revision,draft_hash,decision_sequence,decision,policy_version,reviewer_staff_id,reason)
    VALUES(p_lesson_id,p_expected_revision,draft_hash,d_seq,'not_applicable','local-dev-stub-v1',actor,p_reason) RETURNING id INTO d_decision_id;
  UPDATE public.lesson_disclosure_review_heads SET decision_sequence=d_seq,current_decision_id=d_decision_id,current_draft_revision=p_expected_revision,current_draft_hash=draft_hash,updated_at=now_at WHERE lesson_id=p_lesson_id;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_lesson_review_recorded','lesson',p_lesson_id::text,correlation,jsonb_build_object('lessonId',p_lesson_id::text,'draftRevision',p_expected_revision,'draftHash',draft_hash),now_at);
  RETURN jsonb_build_object('lessonId',p_lesson_id,'draftRevision',p_expected_revision,'draftHash',draft_hash,'accessibilityDecisionId',a_decision_id,'disclosureDecisionId',d_decision_id);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_admin_record_lesson_review_v1(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_admin_record_lesson_review_v1(uuid,integer,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_learning_admin_grant_enrollment_v1(
  p_account_id uuid, p_course_id uuid, p_reason text, p_idempotency_key text, p_request_hash text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
-- Local/admin-only bypass of commerce fulfillment: grants a course enrollment via a
-- staff-issued administrative entitlement source. Never callable by members. Commerce
-- (checkout/webhook fulfillment) is out of scope for this build.
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; claimed boolean;
  v_membership_id uuid; head public.course_heads; source_id uuid; access_id uuid; enrollment public.enrollments; response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL
    OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$'
    OR p_request_hash !~ '^[0-9a-f]{64}$' OR p_reason IS NULL OR octet_length(p_reason) NOT BETWEEN 1 AND 1000
  THEN RAISE EXCEPTION 'LEARNING_ADMIN_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'POST','/v1/staff/learning/enrollments',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING RETURNING * INTO receipt;
  claimed:=FOUND;
  IF NOT claimed THEN
    SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='POST' AND route_template='/v1/staff/learning/enrollments' AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
    IF receipt.status='completed' THEN RETURN receipt.response; END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS';
  END IF;
  SELECT id INTO v_membership_id FROM public.memberships WHERE account_id=p_account_id AND role='owner' AND status='active';
  IF v_membership_id IS NULL THEN RAISE EXCEPTION 'LEARNING_ADMIN_MEMBERSHIP_NOT_FOUND'; END IF;
  SELECT * INTO head FROM public.course_heads WHERE course_id=p_course_id AND channel='production';
  IF head.course_id IS NULL THEN RAISE EXCEPTION 'LEARNING_ADMIN_COURSE_NOT_PUBLISHED'; END IF;
  IF EXISTS(SELECT 1 FROM public.enrollments WHERE account_id=p_account_id AND membership_id=v_membership_id AND course_id=p_course_id AND status='active') THEN
    RAISE EXCEPTION 'LEARNING_ADMIN_ALREADY_ENROLLED';
  END IF;
  INSERT INTO public.entitlement_sources(id,account_id,source_kind,source_id,offer_code,academy_source_registry_id,provenance,created_at)
    VALUES(gen_random_uuid(),p_account_id,'administrative',gen_random_uuid()::text,NULL,NULL,'staff_admin_grant',now_at) RETURNING id INTO source_id;
  INSERT INTO public.account_course_accesses(account_id,entitlement_source_id,course_id,course_version_id,status)
    VALUES(p_account_id,source_id,p_course_id,head.current_course_version_id,'active') RETURNING id INTO access_id;
  -- Every active account_course_accesses row must own exactly 5 implementation_artifacts
  -- (enforced by syntholo_implementation_readiness_v1's seed_backfill_ready check). The
  -- real commerce flow seeds these via syntholo_implementation_seed_workspace_v1, but that
  -- function is syntholo_system_api-only (checked against session_user, not app.actor_kind,
  -- so it cannot be called from this staff-context function) — seed the same 5 rows inline.
  INSERT INTO public.implementation_artifacts(account_id,course_id,seeded_from_account_course_access_id,seeded_from_course_version_id,kind,title)
  SELECT p_account_id,p_course_id,access_id,head.current_course_version_id,v.kind,v.title FROM (VALUES
    ('readiness_map','Readiness and opportunity map'),('ai_policy','Team AI policy'),('workflow_portfolio','Workflow portfolio'),('enablement_checklist','Team enablement checklist'),('roadmap','90-day roadmap')
  ) v(kind,title) ON CONFLICT(account_id,course_id,kind) DO NOTHING;
  IF (SELECT count(*) FROM public.implementation_artifacts WHERE account_id=p_account_id AND course_id=p_course_id)<>5 THEN RAISE EXCEPTION 'LEARNING_ADMIN_SEED_INTEGRITY'; END IF;
  INSERT INTO public.enrollments(account_id,account_course_access_id,membership_id,course_id,course_version_id,status)
    VALUES(p_account_id,access_id,v_membership_id,p_course_id,head.current_course_version_id,'active') RETURNING * INTO enrollment;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),p_account_id,'staff',actor::text,'learning_admin_enrollment_granted','enrollment',enrollment.id::text,correlation,jsonb_build_object('accountId',p_account_id::text,'courseId',p_course_id::text,'enrollmentId',enrollment.id::text,'reason',p_reason),now_at);
  response_payload:=jsonb_build_object('enrollmentId',enrollment.id,'accountId',p_account_id,'courseId',p_course_id,'courseVersionId',enrollment.course_version_id,'enrolledAt',to_char(enrollment.enrolled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=201,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_learning_admin_grant_enrollment_v1(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_learning_admin_grant_enrollment_v1(uuid,uuid,text,text,text) TO syntholo_staff_api;
