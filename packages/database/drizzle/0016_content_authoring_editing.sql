-- Content authoring: real editing support (course update, draft-tree read) and a
-- real customers list for staff, closing the gaps left by 0015_content_authoring.sql.
--
-- `syntholo_content_get_course_draft_tree_v1` is deliberately a *separate* read path
-- from the publish-gate-critical `course_draft_manifest_entries` projection used by
-- `syntholo_content_create_preview_v3` — it reads live draft state (including
-- `blocks`/`transcript`, which the manifest projection omits) so editing an existing
-- course doesn't risk touching anything the publish flow depends on.
--
-- `syntholo_staff_list_accounts_v1` is the first list/search surface over `accounts`
-- for staff use (previously only single-record, member-scoped reads existed).
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_update_course_draft_v1(
  p_course_id uuid, p_expected_revision integer, p_title text, p_description text,
  p_idempotency_key text, p_request_hash text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
DECLARE actor uuid:=nullif(current_setting('app.actor_id',true),'')::uuid; correlation uuid:=nullif(current_setting('app.correlation_id',true),'')::uuid;
  now_at timestamptz(3):=date_trunc('milliseconds',clock_timestamp()); receipt public.api_command_receipts; claimed boolean;
  draft public.course_drafts; next_revision integer; response_payload jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' OR actor IS NULL OR correlation IS NULL
    OR p_idempotency_key IS NULL OR octet_length(p_idempotency_key) NOT BETWEEN 16 AND 128 OR p_idempotency_key !~ '^[!-~]+$'
    OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR NOT public.syntholo_content_nonblank_v1(p_title,1,255) OR p_title~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'
    OR NOT public.syntholo_content_nonblank_v1(p_description,1,10000) OR p_description~*'(^|[^[:alnum:]_])(todo|tbd|placeholder)([^[:alnum:]_]|$)'
  THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  INSERT INTO public.api_command_receipts(principal_kind,principal_id,method,route_template,idempotency_key,request_hash,status,expires_at,created_at)
  VALUES('staff',actor::text,'PATCH','/v1/staff/content/courses/:courseId',p_idempotency_key,p_request_hash,'in_progress',now_at+interval '30 days',now_at)
  ON CONFLICT(principal_kind,principal_id,method,route_template,idempotency_key) DO NOTHING RETURNING * INTO receipt;
  claimed:=FOUND;
  IF NOT claimed THEN
    SELECT * INTO receipt FROM public.api_command_receipts WHERE principal_kind='staff' AND principal_id=actor::text AND method='PATCH' AND route_template='/v1/staff/content/courses/:courseId' AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF receipt.id IS NULL OR receipt.request_hash<>p_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED'; END IF;
    IF receipt.status='completed' THEN RETURN receipt.response; END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content:course:'||p_course_id::text,0));
  SELECT * INTO draft FROM public.course_drafts WHERE course_id=p_course_id FOR UPDATE;
  IF draft.course_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  IF draft.revision<>p_expected_revision THEN RAISE EXCEPTION 'VERSION_CONFLICT'; END IF;
  next_revision:=draft.revision+1;
  UPDATE public.course_drafts SET revision=next_revision, title=p_title, description=p_description, updated_by_staff_id=actor, updated_at=now_at WHERE course_id=p_course_id;
  UPDATE public.courses SET title=p_title, description=p_description, current_draft_revision=next_revision, updated_at=now_at WHERE id=p_course_id;
  INSERT INTO public.audit_events(id,account_id,actor_type,actor_id,action,target_type,target_id,correlation_id,payload,occurred_at)
  VALUES(gen_random_uuid(),NULL,'staff',actor::text,'content_course_draft_updated','course',p_course_id::text,correlation,jsonb_build_object('courseId',p_course_id::text,'revision',next_revision),now_at);
  response_payload:=jsonb_build_object('courseId',p_course_id,'title',p_title,'description',p_description,'revision',next_revision);
  UPDATE public.api_command_receipts AS command_receipt SET status='completed',response_status=200,response=response_payload,completed_at=now_at WHERE command_receipt.id=receipt.id;
  RETURN response_payload;
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_update_course_draft_v1(uuid,integer,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_update_course_draft_v1(uuid,integer,text,text,text,text) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_content_get_course_draft_tree_v1(p_course_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
-- Deliberately reads live draft state from courses/course_drafts/stages/stage_drafts/
-- lessons/lesson_drafts directly, NOT the course_draft_manifest_entries projection
-- (which only reflects published lesson versions and omits blocks/transcript). This
-- keeps the publish-gate-critical manifest path untouched.
DECLARE course public.courses; draft public.course_drafts; stages_json jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' THEN RAISE EXCEPTION 'CONTENT_COMMAND_INVALID'; END IF;
  SELECT * INTO course FROM public.courses WHERE id=p_course_id;
  IF course.id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  SELECT * INTO draft FROM public.course_drafts WHERE course_id=p_course_id;
  IF draft.course_id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND'; END IF;
  SELECT coalesce(jsonb_agg(stage_obj ORDER BY (stage_obj->>'order')::int),'[]'::jsonb) INTO stages_json FROM (
    SELECT jsonb_build_object(
      'stageId',s.id,'slug',s.slug,'title',sd.title,'description',sd.description,
      'order',sd."order",'revision',sd.revision,
      'lessons',(
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'lessonId',l.id,'slug',l.slug,'title',ld.title,'summary',ld.summary,
          'durationSeconds',ld.duration_seconds,'blocks',ld.blocks,'transcript',ld.transcript,
          'order',ld."order",'required',ld.required,'revision',ld.revision
        ) ORDER BY ld."order"),'[]'::jsonb)
        FROM public.lessons l JOIN public.lesson_drafts ld ON ld.lesson_id=l.id
        WHERE l.stage_id=s.id
      )
    ) stage_obj
    FROM public.stages s JOIN public.stage_drafts sd ON sd.stage_id=s.id
    WHERE s.course_id=p_course_id
  ) t;
  RETURN jsonb_build_object(
    'courseId',course.id,'slug',course.slug,'title',draft.title,'description',draft.description,
    'revision',draft.revision,'stages',stages_json
  );
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_get_course_draft_tree_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_get_course_draft_tree_v1(uuid) TO syntholo_staff_api;
--> statement-breakpoint
CREATE FUNCTION public.syntholo_staff_list_accounts_v1(p_query text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
-- First list/search surface over accounts for staff use. Returns each account's id,
-- name, status, active owner's email (if any), and active enrolled-course count, so
-- staff can find an account instead of typing a raw UUID.
DECLARE result jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' THEN RAISE EXCEPTION 'LEARNING_ADMIN_COMMAND_INVALID'; END IF;
  IF p_query IS NOT NULL AND octet_length(p_query)>200 THEN RAISE EXCEPTION 'LEARNING_ADMIN_COMMAND_INVALID'; END IF;
  SELECT coalesce(jsonb_agg(row_obj),'[]'::jsonb) INTO result FROM (
    SELECT jsonb_build_object(
      'accountId',a.id,'accountName',a.name,'status',a.status,'ownerEmail',mi.email,
      'enrolledCourseCount',(SELECT count(*) FROM public.enrollments e WHERE e.account_id=a.id AND e.status='active')
    ) row_obj
    FROM public.accounts a
    LEFT JOIN public.memberships m ON m.account_id=a.id AND m.role='owner' AND m.status='active'
    LEFT JOIN public.member_identities mi ON mi.id=m.member_identity_id
    WHERE p_query IS NULL OR a.name ILIKE '%'||p_query||'%' OR mi.email ILIKE '%'||p_query||'%'
    ORDER BY a.created_at DESC
    LIMIT 200
  ) t;
  RETURN jsonb_build_object('accounts',result);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_staff_list_accounts_v1(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_staff_list_accounts_v1(text) TO syntholo_staff_api;

CREATE FUNCTION public.syntholo_content_list_courses_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
-- Course list for the staff authoring UI. Staff has no direct SELECT on
-- public.enrollments (RLS there is scoped to syntholo_member_api's own account),
-- so the enrolled-count join must go through this SECURITY DEFINER function rather
-- than a raw query from the API layer.
DECLARE result jsonb;
BEGIN
  PERFORM public.syntholo_attest_runtime_capability('syntholo_staff_api');
  IF current_setting('app.actor_kind',true)<>'staff' THEN RAISE EXCEPTION 'LEARNING_ADMIN_COMMAND_INVALID'; END IF;
  SELECT coalesce(jsonb_agg(row_obj),'[]'::jsonb) INTO result FROM (
    SELECT jsonb_build_object(
      'courseId',c.id,'slug',c.slug,'title',cd.title,'description',cd.description,
      'revision',cd.revision,'published',(h.course_id IS NOT NULL),
      'createdAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'enrolledCount',coalesce((SELECT count(*) FROM public.enrollments e WHERE e.course_id=c.id AND e.status='active'),0)
    ) row_obj
    FROM public.courses c
    JOIN public.course_drafts cd ON cd.course_id=c.id
    LEFT JOIN public.course_heads h ON h.course_id=c.id AND h.channel='production'
    ORDER BY c.created_at DESC
  ) t;
  RETURN jsonb_build_object('courses',result);
END $f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.syntholo_content_list_courses_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.syntholo_content_list_courses_v1() TO syntholo_staff_api;
